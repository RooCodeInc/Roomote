import { createHash, randomUUID } from 'node:crypto';

import {
  BOX_CAPABILITIES as BOX_CAPABILITIES_VALUE,
  SANDBOX_SERVER_PORT,
  type ComputeProvider,
} from '@roomote/types';

import { sleepWithSignal, throwIfAborted } from '../modal/abort';
import { BoxApiError, BoxTransport } from './box-transport';
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
/**
 * Default box TTL when BOX_TIMEOUT_MS is not configured. Free-trial Box
 * accounts reject creates with ttlSeconds above 2 hours
 * (`trial_auto_stop_required`), so default to the largest value that works
 * everywhere; paid accounts can raise it via BOX_TIMEOUT_MS. The worker
 * snapshots to standby just before this deadline, so tasks resume cleanly.
 */
export const DEFAULT_BOX_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const BOX_CREATE_METADATA_KEYS = {
  ttlSeconds: 'box.ttlSeconds',
  type: 'box.type',
  env: 'box.env',
} as const;

const BOXES_PATH = '/boxes';
const NAMED_SNAPSHOTS_PATH = '/named-snapshots';
/**
 * Prefix for Box named snapshots (templates) Roomote creates. Spawn code
 * relies on it to tell a template name apart from a `bx_` box id when a
 * SnapshotResume payload carries either.
 */
export const BOX_SNAPSHOT_NAME_PREFIX = 'roomote-snap-';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_READINESS_TIMEOUT_MS = 5 * 60_000;
const READY_MACHINE_STATES = new Set(['ready', 'idle', 'running']);
const PENDING_MACHINE_STATES = new Set([
  'pending',
  'provisioning',
  'provisioned',
  'cloning',
  'init',
  'box_starting',
  'machine_not_running',
]);
// Refused-without-effect errors that resolve on their own: commands sent
// while a box is provisioning (surfaced as 409, or 400 for
// machine_not_running early in provisioning, per the Box platform guide),
// and forks requested while the source named snapshot is still saving.
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

interface BoxApiNamedSnapshot {
  name?: string;
  boxId?: string;
  status?: string;
}

const SNAPSHOT_PENDING_STATES = new Set([
  'saving',
  'creating',
  'pending',
  'in_progress',
  'queued',
]);
const SNAPSHOT_FAILED_STATES = new Set(['failed', 'error']);

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

export { BoxApiError } from './box-transport';

export class BoxClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'box';
  public readonly capabilities: ComputeProviderCapabilities =
    BOX_CAPABILITIES_VALUE;

  private readonly transport: BoxTransport;

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
    this.transport = new BoxTransport(
      config,
      config.boxApiBaseUrl ?? DEFAULT_BOX_API_BASE_URL,
      () => this.pollIntervalMs(),
      () => this.readinessTimeoutMs(),
    );
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
    return this.launchInstance(input);
  }

  private async launchInstance(
    input: CreateInstanceInput,
    fromSnapshotName?: string,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);
    const lifecycle = resolveLifecycleOptions(this.config, input.metadata);
    const body = {
      ...buildLifecycleBody(lifecycle),
      // Deploy from a named snapshot (template). The fork does not inherit
      // the source's lifetime, so the explicit ttlSeconds above still rules.
      ...(fromSnapshotName ? { from: fromSnapshotName } : {}),
    };

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
      await this.stopAndWaitForArchive(knownInstanceId, {
        force: true,
      }).catch(() => {});
      throw error;
    }
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    // Public API v1 currently exposes stop, not hard delete. Stop archives the
    // box and pauses billing, but does not permanently erase retained state.
    await this.stopAndWaitForArchive(input.instanceId, {
      signal: input.signal,
      force: true,
    });
    return {};
  }

  public async enterStandby(
    input: EnterStandbyInput,
  ): Promise<EnterStandbyResult> {
    await this.stopAndWaitForArchive(input.instanceId, {
      signal: input.signal,
    });
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
    for await (const update of this.pollCommandOutput(input)) {
      yield* update.events;
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
    input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throwIfAborted(input.signal);
    const snapshotId = deriveBoxSnapshotName(input.instanceId);

    await this.request('POST', NAMED_SNAPSHOTS_PATH, {
      body: { boxId: input.instanceId, name: snapshotId },
      signal: input.signal,
    });
    await this.waitForNamedSnapshot(snapshotId, input.signal);

    // Persist before stopping the source: the template name is the only
    // handle to the snapshot once the box is archived.
    await input.onSnapshotCreated?.(snapshotId);

    // Match the shared snapshot-destroys-sandbox contract. The named
    // snapshot is the durable artifact, so discard the box's own tail state.
    await this.stopAndWaitForArchive(input.instanceId, {
      signal: input.signal,
      force: true,
    });

    return { snapshotId };
  }

  public async resumeFromSnapshot(
    input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    const created = await this.launchInstance(input, input.sourceSnapshotId);
    return { ...created, sourceSnapshotId: input.sourceSnapshotId };
  }

  private async waitForNamedSnapshot(
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs();
    while (true) {
      const response = await this.request<
        | BoxApiNamedSnapshot[]
        | { snapshots?: BoxApiNamedSnapshot[] }
        | undefined
      >('GET', NAMED_SNAPSHOTS_PATH, { signal, retryRead: true });
      const snapshots = Array.isArray(response)
        ? response
        : (response?.snapshots ?? []);
      const snapshot = snapshots.find((entry) => entry.name === name);
      const status = snapshot?.status?.toLowerCase();

      if (status && SNAPSHOT_FAILED_STATES.has(status)) {
        throw new Error(
          `Box named snapshot ${name} entered ${status} while waiting for completion`,
        );
      }
      // Listed without an in-progress status means the template is usable.
      if (snapshot && (!status || !SNAPSHOT_PENDING_STATES.has(status))) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Box named snapshot ${name}`);
      }
      await sleepWithSignal(this.pollIntervalMs(), signal);
    }
  }

  private async monitorDetachedCommand(
    input: RunCommandInput,
    commandId: string,
  ): Promise<void> {
    for await (const update of this.pollCommandOutput({
      instanceId: input.instanceId,
      commandId,
      signal: input.signal,
    })) {
      update.events.forEach((event) => input.onOutput?.(event));
      if (update.exitCode !== undefined) {
        await input.onExit?.({ exitCode: update.exitCode });
      }
    }
  }

  private async *pollCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<{ events: CommandOutputEvent[]; exitCode?: number }> {
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
      const events: CommandOutputEvent[] = [];
      if (stdout.length > stdoutLength) {
        events.push({ stream: 'stdout', data: stdout.slice(stdoutLength) });
        stdoutLength = stdout.length;
      }
      if (stderr.length > stderrLength) {
        events.push({ stream: 'stderr', data: stderr.slice(stderrLength) });
        stderrLength = stderr.length;
      }
      if (isTerminalCommand(command)) {
        yield { events, exitCode: command.exitCode ?? 1 };
        return;
      }
      if (events.length > 0) yield { events };
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
      // The private-hosting gate rejects credential-less CORS preflights, so
      // browsers can never reach a private port cross-origin. The sandbox
      // server enforces its own bearer auth (same trust model as the other
      // providers' publicly reachable domains), so host it ungated. User app
      // ports stay behind the token gate.
      const isSandboxServer = port === SANDBOX_SERVER_PORT;
      const result = await this.runCommand({
        instanceId,
        cmd: 'host',
        args: [String(port), isSandboxServer ? '--public' : '--private'],
        signal,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Box hosting failed for port ${port} with exit code ${result.exitCode ?? 'unknown'}`,
        );
      }
      domains[String(port)] = parseHostedUrl(result.stdout ?? '');
    }
    return domains;
  }

  private async stopAndWaitForArchive(
    instanceId: string,
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<void> {
    const { signal, force } = options;
    try {
      // Stop refuses when the pre-stop snapshot fails; `force` stops anyway
      // and discards writes since the last snapshot. Only discard paths
      // (destroy) pass it — standby needs the snapshot to resume from.
      await this.request('POST', `${boxPath(instanceId)}/stop`, {
        signal,
        ...(force ? { body: { force: true } } : {}),
      });
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
    return this.transport
      .request<BoxApiMachine | { box?: BoxApiMachine }>(
        'GET',
        boxPath(instanceId),
        { signal, retryRead: true },
      )
      .then((response) => unwrapMachine(response));
  }

  private getCommand(
    instanceId: string,
    commandId: string,
    signal?: AbortSignal,
  ) {
    return this.transport.request<BoxApiCommandResult>(
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

  private request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      signal?: AbortSignal;
      retryRead?: boolean;
    },
  ): Promise<T> {
    return this.transport.request<T>(method, path, options);
  }
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

function parseHostedUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s"']+/);
  if (!match) throw new Error('Box hosting command returned no URL');
  const url = new URL(match[0]);
  if (url.protocol !== 'https:') {
    throw new Error('Box hosting command returned a non-HTTPS URL');
  }
  // Downstream consumers append paths (`${domain}/trpc`), so a bare-origin
  // URL must not keep the trailing slash URL normalization adds.
  const pathname = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}${pathname}${url.search}`;
}

function isBoxNotFound(error: unknown): boolean {
  return error instanceof BoxApiError && error.metadata.status === 404;
}

export function deriveBoxMachineName(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `roomote-${digest.slice(0, 32)}`;
}

// Named-snapshot names are account-global, so make every capture unique; the
// name doubles as the Roomote snapshot id.
function deriveBoxSnapshotName(instanceId: string): string {
  const digest = createHash('sha256')
    .update(`${instanceId}:${Date.now()}:${randomUUID()}`)
    .digest('hex');
  return `${BOX_SNAPSHOT_NAME_PREFIX}${digest.slice(0, 16)}`;
}
