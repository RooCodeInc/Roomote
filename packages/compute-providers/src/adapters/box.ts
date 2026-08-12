import { createHash } from 'node:crypto';

import {
  BOX_CAPABILITIES as BOX_CAPABILITIES_VALUE,
  type ComputeProvider,
} from '@roomote/types';

import { UnsupportedComputeProviderOperationError } from '../errors';
import { sleepWithSignal, throwIfAborted } from '../modal/abort';
import type {
  BoxConfig,
  CommandOutputEvent,
  ComputeInstanceStatus,
  ComputeProviderCapabilities,
  ComputeProviderClient,
  CreateInstanceInput,
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreatedInstance,
  DestroyInstanceInput,
  DestroyInstanceResult,
  EnterStandbyInput,
  EnterStandbyResult,
  GetCommandOutputInput,
  GetInstanceDomainsInput,
  GetInstanceDomainsResult,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ResumeFromStandbyInput,
  ResumeInstanceInput,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';

export const DEFAULT_BOX_API_BASE_URL = 'https://ascii.dev/api/box/v1';
export const BOX_CREATE_METADATA_KEYS = {
  ttlSeconds: 'box.ttlSeconds',
  type: 'box.type',
  env: 'box.env',
} as const;

const BOXES_PATH = '/boxes';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_READINESS_TIMEOUT_MS = 5 * 60_000;
const READ_RETRY_ATTEMPTS = 3;
const READY_MACHINE_STATES = new Set(['ready', 'idle', 'running']);
const PENDING_MACHINE_STATES = new Set([
  'pending',
  'provisioning',
  'provisioned',
  'cloning',
  'init',
]);
const VALID_MACHINE_TYPES = new Set(['small', 'default', 'large']);

type BoxMachineType = NonNullable<BoxConfig['machineType']>;

interface BoxApiMachine {
  id?: string;
  state?: string;
  archiveAfter?: string | number;
  createdAt?: string;
}

interface BoxApiCommandStart {
  processId?: number;
}

interface BoxApiCommandResult {
  processId?: number;
  status?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

interface BoxLifecycleOptions {
  ttlSeconds?: number;
  type?: BoxMachineType;
  env?: Record<string, string>;
}

export interface BoxApiErrorMetadata {
  method: string;
  path: string;
  status: number;
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class BoxApiError extends Error {
  public constructor(public readonly metadata: BoxApiErrorMetadata) {
    super(
      `Box API ${metadata.method} ${metadata.path} failed with status ${metadata.status}` +
        (metadata.errorCode ? ` (${metadata.errorCode})` : '') +
        (metadata.errorMessage ? `: ${metadata.errorMessage}` : ''),
    );
    this.name = 'BoxApiError';
  }
}

export class BoxClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'box';
  public readonly capabilities: ComputeProviderCapabilities =
    BOX_CAPABILITIES_VALUE;

  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly config: BoxConfig) {
    if (!config.apiKey) throw new Error('Box requires an apiKey');
    if (config.timeoutMs !== undefined) {
      assertPositiveNumber(config.timeoutMs, 'Box timeoutMs');
    }
    if (
      config.machineType !== undefined &&
      !VALID_MACHINE_TYPES.has(config.machineType)
    ) {
      throw new Error('Box machineType must be one of: small, default, large');
    }
    this.apiBaseUrl = trimTrailingSlashes(
      config.boxApiBaseUrl ?? DEFAULT_BOX_API_BASE_URL,
    );
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  public async listInstances(
    input: ListInstancesInput,
  ): Promise<InstanceSummary[]> {
    const response = await this.request<
      BoxApiMachine[] | { boxes?: BoxApiMachine[] }
    >('GET', BOXES_PATH, { signal: input.signal, retryRead: true });
    const boxes = Array.isArray(response) ? response : (response.boxes ?? []);
    return boxes.map(summarizeMachine);
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    try {
      const summary = summarizeMachine(
        await this.getMachine(input.instanceId, input.signal),
      );
      return {
        status: summary.status,
        timeoutRemainingMs: summary.timeoutRemainingMs,
      };
    } catch (error) {
      if (isBoxNotFound(error)) return { status: 'stopped' };
      throw error;
    }
  }

  public async createInstance(
    input: CreateInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);
    const lifecycle = resolveLifecycleOptions(this.config, input.metadata);
    const body = buildLifecycleBody(lifecycle);

    // Public API v1 has no create idempotency primitive. Never retry this POST:
    // an abort can leave an unknown server-side result. Deterministic renaming
    // below improves reconciliation after a known response; it is not atomic.
    const response = await this.request<
      BoxApiMachine | { box?: BoxApiMachine }
    >('POST', BOXES_PATH, { body, signal: input.signal });
    let machine = unwrapMachine(response);
    let knownInstanceId = machineId(machine);

    try {
      if (input.idempotencyKey) {
        const renamed = await this.request<
          BoxApiMachine | { box?: BoxApiMachine } | undefined
        >('PATCH', boxPath(knownInstanceId), {
          body: { name: deriveBoxMachineName(input.idempotencyKey) },
          signal: input.signal,
        });
        machine = unwrapMachine(renamed, machine);
        knownInstanceId = machineId(machine);
      }

      if (!isMachineReady(machine)) {
        machine = await this.waitUntilReady(knownInstanceId, input.signal);
      }
      const domains = input.ports?.length
        ? await this.resolvePrivateDomains(
            knownInstanceId,
            input.ports,
            input.signal,
          )
        : undefined;
      return {
        instanceId: knownInstanceId,
        status: mapMachineState(machine.state),
        ...(domains ? { domains } : {}),
      };
    } catch (error) {
      // Once create returns an ID, every later failure has a known cleanup
      // target, including failures after deterministic rename.
      await this.stopAndWaitForArchive(knownInstanceId).catch(() => {});
      throw error;
    }
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    // Public API v1 currently exposes stop, not hard delete. Stop archives the
    // box and pauses billing, but does not permanently erase retained state.
    await this.stopAndWaitForArchive(input.instanceId, input.signal);
    return {};
  }

  public async enterStandby(
    input: EnterStandbyInput,
  ): Promise<EnterStandbyResult> {
    await this.stopAndWaitForArchive(input.instanceId, input.signal);
    return { resumeHandle: input.instanceId };
  }

  public async resumeFromStandby(
    input: ResumeFromStandbyInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);
    const lifecycle = resolveLifecycleOptions(this.config, input.metadata);
    await this.request('POST', `${boxPath(input.resumeHandle)}/resume`, {
      body: buildLifecycleBody(lifecycle),
      signal: input.signal,
    });
    const machine = await this.waitUntilReady(input.resumeHandle, input.signal);
    const domains = input.ports?.length
      ? await this.resolvePrivateDomains(
          input.resumeHandle,
          input.ports,
          input.signal,
        )
      : undefined;
    return {
      instanceId: input.resumeHandle,
      sourceSnapshotId: input.resumeHandle,
      status: mapMachineState(machine.state),
      ...(domains ? { domains } : {}),
    };
  }

  public async getInstanceDomains(
    input: GetInstanceDomainsInput,
  ): Promise<GetInstanceDomainsResult> {
    return {
      domains: await this.resolvePrivateDomains(
        input.instanceId,
        input.ports,
        input.signal,
      ),
    };
  }

  public async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    throwIfAborted(input.signal);
    const command = buildShellCommand(input);
    const response = await this.request<
      BoxApiCommandStart | BoxApiCommandResult
    >('POST', `${boxPath(input.instanceId)}/commands`, {
      body: {
        command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.detached ? { detached: true } : {}),
      },
      signal: input.signal,
    });

    if (!input.detached) {
      const result = response as BoxApiCommandResult;
      emitCommandOutput(result, input.onOutput);
      return {
        exitCode: result.exitCode ?? 0,
        ...(result.stdout ? { stdout: result.stdout } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }

    const processId = (response as BoxApiCommandStart).processId;
    if (!Number.isInteger(processId)) {
      throw new Error(
        'Box detached command response did not include processId',
      );
    }
    const commandId = String(processId);
    if (input.onOutput || input.onExit) {
      void this.monitorDetachedCommand(input, commandId).catch(() => {});
    }
    return { commandId, exitCode: null };
  }

  public async *streamCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    let stdoutLength = 0;
    let stderrLength = 0;

    while (true) {
      const command = await this.getCommand(
        input.instanceId,
        input.commandId,
        input.signal,
      );
      const stdout = command.stdout ?? '';
      const stderr = command.stderr ?? '';
      if (stdout.length > stdoutLength) {
        yield { stream: 'stdout', data: stdout.slice(stdoutLength) };
        stdoutLength = stdout.length;
      }
      if (stderr.length > stderrLength) {
        yield { stream: 'stderr', data: stderr.slice(stderrLength) };
        stderrLength = stderr.length;
      }
      if (isTerminalCommand(command)) return;
      await sleepWithSignal(this.pollIntervalMs(), input.signal);
    }
  }

  public async getCommandOutput(input: GetCommandOutputInput): Promise<string> {
    const command = await this.getCommand(
      input.instanceId,
      input.commandId,
      input.signal,
    );
    const stdout = command.stdout ?? '';
    const stderr = command.stderr ?? '';
    if (input.stream === 'stdout') return stdout;
    if (input.stream === 'stderr') return stderr;
    return `${stdout}${stderr}`;
  }

  public async writeFiles(input: WriteFileInput): Promise<void> {
    for (const file of input.files) {
      throwIfAborted(input.signal);
      await this.request('PUT', `${boxPath(input.instanceId)}/files`, {
        body: {
          path: file.path,
          content: file.content.toString('base64'),
          encoding: 'base64',
        },
        signal: input.signal,
      });
    }
  }

  public async createSnapshot(
    _input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throw new UnsupportedComputeProviderOperationError('box', 'createSnapshot');
  }

  public async resumeFromSnapshot(
    _input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    throw new UnsupportedComputeProviderOperationError(
      'box',
      'resumeFromSnapshot',
    );
  }

  private async monitorDetachedCommand(
    input: RunCommandInput,
    commandId: string,
  ): Promise<void> {
    let stdoutLength = 0;
    let stderrLength = 0;
    while (true) {
      const command = await this.getCommand(
        input.instanceId,
        commandId,
        input.signal,
      );
      const stdout = command.stdout ?? '';
      const stderr = command.stderr ?? '';
      if (stdout.length > stdoutLength) {
        input.onOutput?.({
          stream: 'stdout',
          data: stdout.slice(stdoutLength),
        });
        stdoutLength = stdout.length;
      }
      if (stderr.length > stderrLength) {
        input.onOutput?.({
          stream: 'stderr',
          data: stderr.slice(stderrLength),
        });
        stderrLength = stderr.length;
      }
      if (isTerminalCommand(command)) {
        await input.onExit?.({ exitCode: command.exitCode ?? 1 });
        return;
      }
      await sleepWithSignal(this.pollIntervalMs(), input.signal);
    }
  }

  private async resolvePrivateDomains(
    instanceId: string,
    ports: number[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const domains: Record<string, string> = {};
    for (const port of ports) {
      const result = await this.runCommand({
        instanceId,
        cmd: 'host',
        args: [String(port), '--private'],
        signal,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Box private hosting failed for port ${port} with exit code ${result.exitCode ?? 'unknown'}`,
        );
      }
      domains[String(port)] = parsePrivateUrl(result.stdout ?? '');
    }
    return domains;
  }

  private async stopAndWaitForArchive(
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.request('POST', `${boxPath(instanceId)}/stop`, { signal });
    } catch (error) {
      if (isBoxNotFound(error)) return;
      throw error;
    }

    const deadline = Date.now() + this.readinessTimeoutMs();
    while (true) {
      let machine: BoxApiMachine;
      try {
        machine = await this.getMachine(instanceId, signal);
      } catch (error) {
        if (isBoxNotFound(error)) return;
        throw error;
      }
      if (machine.state?.toLowerCase() === 'archived') return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Box ${instanceId} to archive`);
      }
      await sleepWithSignal(this.pollIntervalMs(), signal);
    }
  }

  private async waitUntilReady(
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<BoxApiMachine> {
    const deadline = Date.now() + this.readinessTimeoutMs();
    while (true) {
      const machine = await this.getMachine(instanceId, signal);
      if (isMachineReady(machine)) return machine;
      const status = mapMachineState(machine.state);
      if (status === 'failed' || status === 'stopped') {
        throw new Error(
          `Box ${instanceId} entered ${machine.state ?? status} while waiting for readiness`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Box ${instanceId} readiness`);
      }
      await sleepWithSignal(this.pollIntervalMs(), signal);
    }
  }

  private getMachine(instanceId: string, signal?: AbortSignal) {
    return this.request<BoxApiMachine | { box?: BoxApiMachine }>(
      'GET',
      boxPath(instanceId),
      { signal, retryRead: true },
    ).then((response) => unwrapMachine(response));
  }

  private getCommand(
    instanceId: string,
    commandId: string,
    signal?: AbortSignal,
  ) {
    return this.request<BoxApiCommandResult>(
      'GET',
      `${boxPath(instanceId)}/commands/${encodeURIComponent(commandId)}`,
      { signal, retryRead: true },
    );
  }

  private pollIntervalMs(): number {
    return this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private readinessTimeoutMs(): number {
    return this.config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      signal?: AbortSignal;
      retryRead?: boolean;
    } = {},
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      throwIfAborted(options.signal);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'application/json',
            ...(options.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: options.signal,
        });
      } catch {
        throwIfAborted(options.signal);
        throw new BoxApiError({ method, path, status: 0 });
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new BoxApiError({
            method,
            path,
            status: response.status,
            errorCode: 'invalid_response',
          });
        }
      }

      attempt += 1;
      if (
        options.retryRead &&
        attempt < READ_RETRY_ATTEMPTS &&
        (response.status === 429 || response.status >= 500)
      ) {
        await sleepWithSignal(retryDelayMs(response, attempt), options.signal);
        continue;
      }

      const errorPayload = await readErrorPayload(response);
      const headerRequestId = response.headers.get('x-request-id');
      const errorCode = readErrorPayloadField(errorPayload, 'code');
      const errorMessage = readErrorPayloadField(errorPayload, 'message');
      throw new BoxApiError({
        method,
        path,
        status: response.status,
        ...(headerRequestId
          ? { requestId: headerRequestId }
          : typeof errorPayload?.requestId === 'string'
            ? { requestId: errorPayload.requestId }
            : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage
          ? {
              errorMessage: sanitizeErrorMessage(
                errorMessage,
                this.config.apiKey,
              ),
            }
          : {}),
      });
    }
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function boxPath(instanceId: string): string {
  return `${BOXES_PATH}/${encodeURIComponent(instanceId)}`;
}

function unwrapMachine(
  response: BoxApiMachine | { box?: BoxApiMachine } | undefined,
  fallback?: BoxApiMachine,
): BoxApiMachine {
  const machine =
    (response as { box?: BoxApiMachine } | undefined)?.box ??
    (response as BoxApiMachine | undefined) ??
    fallback;
  if (!machine) throw new Error('Box API response did not include a machine');
  machineId(machine);
  return machine;
}

function machineId(machine: BoxApiMachine): string {
  if (!machine.id) {
    throw new Error('Box API machine response did not include an id');
  }
  return machine.id;
}

function isMachineReady(machine: BoxApiMachine): boolean {
  return READY_MACHINE_STATES.has(machine.state?.toLowerCase() ?? '');
}

function mapMachineState(state: string | undefined): ComputeInstanceStatus {
  const normalized = state?.toLowerCase() ?? '';
  if (READY_MACHINE_STATES.has(normalized)) return 'running';
  if (PENDING_MACHINE_STATES.has(normalized)) return 'pending';
  switch (normalized) {
    case 'stopping':
    case 'archiving':
      return 'stopping';
    case 'stopped':
    case 'archived':
      return 'stopped';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'unknown';
  }
}

function summarizeMachine(machine: BoxApiMachine): InstanceSummary {
  const createdAt = machine.createdAt ? new Date(machine.createdAt) : undefined;
  const archiveAt = parseApiTimestamp(machine.archiveAfter);
  return {
    instanceId: machineId(machine),
    status: mapMachineState(machine.state),
    timeoutRemainingMs:
      archiveAt === undefined ? 0 : Math.max(0, archiveAt - Date.now()),
    ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
  };
}

function parseApiTimestamp(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveLifecycleOptions(
  config: BoxConfig,
  metadata: Record<string, string> | undefined,
): BoxLifecycleOptions {
  const ttlMetadata = metadataValue(
    metadata,
    BOX_CREATE_METADATA_KEYS.ttlSeconds,
    'ttlSeconds',
  );
  const ttlSeconds =
    ttlMetadata === undefined
      ? timeoutMsToTtlSeconds(config.timeoutMs)
      : parsePositiveInteger(ttlMetadata, 'Box ttlSeconds metadata');

  const typeMetadata = metadataValue(
    metadata,
    BOX_CREATE_METADATA_KEYS.type,
    'type',
  );
  const type = typeMetadata ?? config.machineType;
  if (type !== undefined && !VALID_MACHINE_TYPES.has(type)) {
    throw new Error('Box type metadata must be one of: small, default, large');
  }

  const envMetadata = metadataValue(
    metadata,
    BOX_CREATE_METADATA_KEYS.env,
    'env',
  );
  const env =
    envMetadata === undefined ? undefined : parseEnvMetadata(envMetadata);

  return {
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(type !== undefined ? { type: type as BoxMachineType } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

function buildLifecycleBody(
  lifecycle: BoxLifecycleOptions,
): Record<string, unknown> {
  return {
    noEnv: true,
    ...(lifecycle.ttlSeconds !== undefined
      ? { ttlSeconds: lifecycle.ttlSeconds }
      : {}),
    ...(lifecycle.type !== undefined ? { type: lifecycle.type } : {}),
    ...(lifecycle.env !== undefined ? { env: lifecycle.env } : {}),
  };
}

function timeoutMsToTtlSeconds(
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined) return undefined;
  assertPositiveNumber(timeoutMs, 'Box timeoutMs');
  return Math.max(1, Math.ceil(timeoutMs / 1_000));
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function assertPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
}

function parseEnvMetadata(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Box env metadata must be a JSON object', { cause: error });
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    Object.values(parsed).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Box env metadata must contain only string values');
  }
  return parsed as Record<string, string>;
}

function metadataValue(
  metadata: Record<string, string> | undefined,
  preferred: string,
  shortName: string,
): string | undefined {
  return metadata?.[preferred] ?? metadata?.[shortName];
}

function buildShellCommand(input: RunCommandInput): string {
  const command = [input.cmd, ...(input.args ?? [])].map(shellQuote).join(' ');
  const env = Object.entries(input.env ?? {});
  if (env.length === 0) return command;
  return `env ${env.map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ')} ${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function emitCommandOutput(
  command: BoxApiCommandResult,
  callback: RunCommandInput['onOutput'],
): void {
  if (!callback) return;
  if (command.stdout) callback({ stream: 'stdout', data: command.stdout });
  if (command.stderr) callback({ stream: 'stderr', data: command.stderr });
}

function isTerminalCommand(command: BoxApiCommandResult): boolean {
  const status = command.status?.toLowerCase();
  return status === 'exited' || status === 'lost';
}

function parsePrivateUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s"']+/);
  if (!match) throw new Error('Box private hosting command returned no URL');
  const url = new URL(match[0]);
  if (url.protocol !== 'https:') {
    throw new Error('Box private hosting command returned a non-HTTPS URL');
  }
  return url.toString();
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1_000, 10_000);
  }
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

const ERROR_MESSAGE_MAX_LENGTH = 300;

/** Reads `field` from the payload, falling back to the nested `error` object. */
function readErrorPayloadField(
  payload: Record<string, unknown> | undefined,
  field: 'code' | 'message',
): string | undefined {
  const direct = payload?.[field];
  if (typeof direct === 'string' && direct) return direct;
  const nested = payload?.error;
  if (!nested || typeof nested !== 'object') return undefined;
  const value = (nested as Record<string, unknown>)[field];
  return typeof value === 'string' && value ? value : undefined;
}

// Server error text is echoed into task UI and logs; never let it carry our
// bearer token, and cap it so a huge body cannot bloat stored events.
function sanitizeErrorMessage(message: string, apiKey: string): string {
  const redacted = apiKey ? message.replaceAll(apiKey, '[redacted]') : message;
  return redacted.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${redacted.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
    : redacted;
}

async function readErrorPayload(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isBoxNotFound(error: unknown): boolean {
  return error instanceof BoxApiError && error.metadata.status === 404;
}

export function deriveBoxMachineName(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `roomote-${digest.slice(0, 32)}`;
}
