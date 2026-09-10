import { createHash, randomUUID } from 'node:crypto';

import { SandboxInstance, settings } from '@blaxel/core';
import {
  BLAXEL_CAPABILITIES as BLAXEL_CAPABILITIES_VALUE,
  type ComputeProvider,
} from '@roomote/types';

import { raceWithAbort, sleepWithSignal, throwIfAborted } from '../modal/abort';
import type {
  BlaxelConfig,
  CommandOutputEvent,
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
  ResumeInstanceInput,
  ResumeFromStandbyInput,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';
import {
  isBlaxelResourceNotFound,
  isBlaxelWorkloadUnavailable,
} from '../blaxel/errors';

const STREAM_POLL_INTERVAL_MS = 1_000;
const WORKLOAD_READY_RETRY_BUDGET_MS = 60_000;
const WORKLOAD_READY_INITIAL_DELAY_MS = 500;
const WORKLOAD_READY_MAX_DELAY_MS = 30_000;
const DEFAULT_BLAXEL_STANDBY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const BLAXEL_LIST_PAGE_SIZE = 50;

export class BlaxelClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'blaxel';
  public readonly capabilities: ComputeProviderCapabilities =
    BLAXEL_CAPABILITIES_VALUE;

  public constructor(private readonly config: BlaxelConfig) {
    if (!config.apiKey) throw new Error('Blaxel requires an apiKey');
    if (!config.workspace) throw new Error('Blaxel requires a workspace');
    if (!config.image) throw new Error('Blaxel requires an image');

    // The SDK exposes process-wide settings. A controller has one configured
    // Blaxel workspace, so initialize it from Roomote's resolved provider config.
    settings.setConfig({ apiKey: config.apiKey, workspace: config.workspace });
  }

  public async listInstances(
    input: ListInstancesInput,
  ): Promise<InstanceSummary[]> {
    const instances: InstanceSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = await raceWithAbort({
        promise: SandboxInstance.list({
          limit: BLAXEL_LIST_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
        signal: input.signal,
        abortMessage: 'Listing Blaxel sandboxes was aborted',
      });

      for (const sandbox of page.data) {
        throwIfAborted(input.signal);
        if (sandbox.status !== 'TERMINATED') instances.push(summarize(sandbox));
      }
      const nextCursor = page.nextCursor;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error('Blaxel pagination returned a repeated cursor');
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return instances;
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    try {
      const summary = summarize(
        await this.getSandbox(input.instanceId, input.signal),
      );
      return {
        status: summary.status,
        timeoutRemainingMs: summary.timeoutRemainingMs,
      };
    } catch (error) {
      if (isNotFound(error)) return { status: 'stopped' };
      throw error;
    }
  }

  public async createInstance(
    input: CreateInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);
    const isIdempotent = Boolean(input.idempotencyKey);
    const name = input.idempotencyKey
      ? deriveBlaxelSandboxName(input.idempotencyKey)
      : `roomote-${randomUUID()}`.slice(0, 49);
    const ttl = this.ttl();
    const createInput = {
      name,
      image: this.config.image,
      memory: this.config.memoryMiB,
      region: this.config.region,
      ttl,
      ...(input.idempotencyKey ? { externalId: input.idempotencyKey } : {}),
      labels: { ...(input.metadata ?? {}), ...(input.tags ?? {}) },
      ports: input.ports?.map((target) => ({ target, protocol: 'HTTP' })),
    };
    const sandbox = await raceWithAbort({
      promise: isIdempotent
        ? SandboxInstance.createIfNotExists(createInput)
        : SandboxInstance.create(createInput),
      signal: input.signal,
      abortMessage: `Creating Blaxel sandbox ${name} was aborted`,
      ...(!isIdempotent
        ? {
            onLateResolve: async (lateSandbox: SandboxInstance) => {
              await this.cleanupSandboxAfterFailure(
                lateSandbox.metadata.name || name,
                'create_instance_late_abort',
              );
            },
          }
        : {}),
    });

    try {
      await raceWithAbort({
        promise: sandbox.wait({ maxWait: 180_000 }),
        signal: input.signal,
        abortMessage: `Waiting for Blaxel sandbox ${name} was aborted`,
      });
      const domains = await this.createPreviewDomains(
        sandbox,
        input.ports ?? [],
        input.signal,
      );
      return { instanceId: name, status: 'running', domains };
    } catch (error) {
      // Idempotently-created sandboxes are retained for the controller's next
      // attempt. Their TTL still bounds orphan lifetime if the task is canceled.
      if (!isIdempotent) {
        await this.cleanupSandboxAfterFailure(
          name,
          'create_instance_post_create',
        );
      }
      throw error;
    }
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    try {
      await raceWithAbort({
        promise: SandboxInstance.delete(input.instanceId),
        signal: input.signal,
        abortMessage: `Deleting Blaxel sandbox ${input.instanceId} was aborted`,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return {};
  }

  public async enterStandby(
    input: EnterStandbyInput,
  ): Promise<EnterStandbyResult> {
    throwIfAborted(input.signal);

    await retryWorkloadUnavailable({
      operation: () =>
        raceWithAbort({
          promise: SandboxInstance.updateTtl(
            input.instanceId,
            `${Math.ceil(
              (this.config.standbyTtlMs ?? DEFAULT_BLAXEL_STANDBY_TTL_MS) /
                1_000,
            )}s`,
          ),
          signal: input.signal,
          abortMessage: `Extending standby TTL for Blaxel sandbox ${input.instanceId} was aborted`,
        }),
      signal: input.signal,
      description: `extending standby TTL for Blaxel sandbox ${input.instanceId}`,
    });

    if (input.commandId) {
      const sandbox = await this.getSandbox(input.instanceId, input.signal);
      try {
        await retryWorkloadUnavailable({
          operation: () =>
            raceWithAbort({
              promise: sandbox.process.stop(input.commandId!),
              signal: input.signal,
              abortMessage: `Stopping worker ${input.commandId} in Blaxel sandbox ${input.instanceId} was aborted`,
            }),
          signal: input.signal,
          description: `stopping worker ${input.commandId} in Blaxel sandbox ${input.instanceId}`,
        });
      } catch (error) {
        // The worker may have completed between the scheduler deciding to put
        // the sandbox on standby and the stop request reaching Blaxel.
        if (!isNotFound(error)) throw error;
      }
    }

    return { resumeHandle: input.instanceId };
  }

  public async resumeFromStandby(
    input: ResumeFromStandbyInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    await retryWorkloadUnavailable({
      operation: () =>
        raceWithAbort({
          promise: SandboxInstance.updateTtl(
            input.resumeHandle,
            this.ttl() ?? null,
          ),
          signal: input.signal,
          abortMessage: `Restoring active TTL for Blaxel sandbox ${input.resumeHandle} was aborted`,
        }),
      signal: input.signal,
      description: `restoring active TTL for Blaxel sandbox ${input.resumeHandle}`,
    });
    const sandbox = await this.getSandbox(input.resumeHandle, input.signal);
    const domains = await this.createPreviewDomains(
      sandbox,
      input.ports ?? [],
      input.signal,
    );

    return {
      instanceId: input.resumeHandle,
      sourceSnapshotId: input.resumeHandle,
      status: 'running',
      domains,
    };
  }

  public async getInstanceDomains(
    input: GetInstanceDomainsInput,
  ): Promise<GetInstanceDomainsResult> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    return {
      domains: await this.createPreviewDomains(
        sandbox,
        input.ports,
        input.signal,
      ),
    };
  }

  public async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    const name = `roomote-${randomUUID()}`.slice(0, 49);
    const command = [input.cmd, ...(input.args ?? [])]
      .map(shellQuote)
      .join(' ');
    const process = await retryWorkloadUnavailable({
      operation: () =>
        raceWithAbort({
          promise: sandbox.process.exec({
            name,
            command,
            env: input.env,
            workingDir: input.cwd,
            waitForCompletion: !input.detached,
            // Disable Blaxel's default provider-side timeout. Callers bound
            // synchronous execution through their AbortSignal, while detached
            // worker processes remain alive until Roomote tears down the sandbox.
            timeout: 0,
            ...(input.detached ? { keepAlive: true } : {}),
            ...(input.onOutput
              ? {
                  onStdout: (data: string) =>
                    input.onOutput?.({ stream: 'stdout', data }),
                  onStderr: (data: string) =>
                    input.onOutput?.({ stream: 'stderr', data }),
                }
              : {}),
          }),
          signal: input.signal,
          abortMessage: `Running command in Blaxel sandbox ${input.instanceId} was aborted`,
        }),
      signal: input.signal,
      description: `running command ${name} in Blaxel sandbox ${input.instanceId}`,
    });
    return {
      commandId: process.name || name,
      exitCode: process.status === 'running' ? null : process.exitCode,
      stdout: process.stdout,
      stderr: process.stderr,
    };
  }

  public async *streamCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    let stdoutLength = 0;
    let stderrLength = 0;
    while (true) {
      throwIfAborted(input.signal);
      const process = await retryWorkloadUnavailable({
        operation: () =>
          raceWithAbort({
            promise: sandbox.process.get(input.commandId),
            signal: input.signal,
            abortMessage: `Streaming Blaxel command ${input.commandId} was aborted`,
          }),
        signal: input.signal,
        description: `reading command ${input.commandId} in Blaxel sandbox ${input.instanceId}`,
      });
      if (process.stdout.length > stdoutLength) {
        yield { stream: 'stdout', data: process.stdout.slice(stdoutLength) };
        stdoutLength = process.stdout.length;
      }
      if (process.stderr.length > stderrLength) {
        yield { stream: 'stderr', data: process.stderr.slice(stderrLength) };
        stderrLength = process.stderr.length;
      }
      if (process.status !== 'running') return;
      await sleepWithSignal(STREAM_POLL_INTERVAL_MS, input.signal);
    }
  }

  public async getCommandOutput(input: GetCommandOutputInput): Promise<string> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    return retryWorkloadUnavailable({
      operation: () =>
        raceWithAbort({
          promise: sandbox.process.logs(
            input.commandId,
            input.stream === 'both' || input.stream === undefined
              ? 'all'
              : input.stream,
          ),
          signal: input.signal,
          abortMessage: `Reading Blaxel command ${input.commandId} output was aborted`,
        }),
      signal: input.signal,
      description: `reading command ${input.commandId} output in Blaxel sandbox ${input.instanceId}`,
    });
  }

  public async writeFiles(input: WriteFileInput): Promise<void> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    for (const file of input.files) {
      throwIfAborted(input.signal);
      await retryWorkloadUnavailable({
        operation: () =>
          raceWithAbort({
            promise: sandbox.fs.writeBinary(file.path, file.content),
            signal: input.signal,
            abortMessage: `Writing ${file.path} to Blaxel sandbox ${input.instanceId} was aborted`,
          }),
        signal: input.signal,
        description: `writing ${file.path} to Blaxel sandbox ${input.instanceId}`,
      });
    }
  }

  public async createSnapshot(
    _input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throw new Error('Blaxel does not support Roomote snapshots');
  }

  public async resumeFromSnapshot(
    _input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    throw new Error('Blaxel does not support Roomote snapshot resume');
  }

  private getSandbox(instanceId: string, signal?: AbortSignal) {
    return retryWorkloadUnavailable({
      operation: () =>
        raceWithAbort({
          promise: SandboxInstance.get(instanceId),
          signal,
          abortMessage: `Connecting to Blaxel sandbox ${instanceId} was aborted`,
        }),
      signal,
      description: `connecting to Blaxel sandbox ${instanceId}`,
    });
  }

  private ttl(): string | undefined {
    return this.config.timeoutMs
      ? `${Math.ceil(this.config.timeoutMs / 1_000)}s`
      : undefined;
  }

  private async cleanupSandboxAfterFailure(
    instanceId: string,
    context: string,
  ): Promise<void> {
    try {
      await SandboxInstance.delete(instanceId);
    } catch (error) {
      if (isNotFound(error)) return;
      console.error(
        `[BlaxelClient] Failed to clean up sandbox after ${context} ${JSON.stringify(
          {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          },
        )}`,
      );
    }
  }

  private async createPreviewDomains(
    sandbox: SandboxInstance,
    ports: number[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const domains: Record<string, string> = {};
    for (const port of ports) {
      const previewName = `port-${port}`;
      const preview = await retryWorkloadUnavailable({
        operation: () =>
          raceWithAbort({
            promise: sandbox.previews.createIfNotExists({
              metadata: { name: previewName },
              // The child preview follows the parent sandbox lifecycle. Giving
              // it a shorter TTL forces destructive refreshes after standby.
              spec: { port, public: true },
            }),
            signal,
            abortMessage: `Creating Blaxel preview for port ${port} was aborted`,
          }),
        signal,
        description: `creating preview ${previewName} for Blaxel sandbox ${sandbox.metadata.name}`,
      });
      if (!preview.spec.url) {
        throw new Error(
          `Blaxel preview for sandbox ${sandbox.metadata.name} port ${port} has no URL`,
        );
      }
      domains[String(port)] = preview.spec.url;
    }
    return domains;
  }
}

function summarize(sandbox: SandboxInstance): InstanceSummary {
  const createdAt = sandbox.metadata.createdAt
    ? new Date(sandbox.metadata.createdAt)
    : undefined;
  return {
    instanceId: sandbox.metadata.name,
    status: mapStatus(sandbox.status),
    timeoutRemainingMs: Math.max(0, (sandbox.expiresIn ?? 0) * 1_000),
    ...(createdAt ? { createdAt } : {}),
  };
}

function mapStatus(
  status: SandboxInstance['status'],
): InstanceSummary['status'] {
  switch (status) {
    case 'DEPLOYED':
    case 'BUILT':
      return 'running';
    case 'BUILDING':
    case 'DEPLOYING':
    case 'UPLOADING':
      return 'pending';
    case 'DELETING':
    case 'DEACTIVATING':
      return 'stopping';
    case 'TERMINATED':
    case 'DEACTIVATED':
      return 'stopped';
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isNotFound(error: unknown): boolean {
  return isBlaxelResourceNotFound(error);
}

async function retryWorkloadUnavailable<T>(options: {
  operation: () => Promise<T>;
  signal?: AbortSignal;
  description: string;
}): Promise<T> {
  const startedAt = Date.now();
  let delayMs = WORKLOAD_READY_INITIAL_DELAY_MS;

  while (true) {
    throwIfAborted(options.signal);
    try {
      return await options.operation();
    } catch (error) {
      if (!isBlaxelWorkloadUnavailable(error)) throw error;

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = WORKLOAD_READY_RETRY_BUDGET_MS - elapsedMs;
      if (remainingMs <= 0) throw error;

      const effectiveDelayMs = Math.min(delayMs, remainingMs);
      console.warn(
        `[BlaxelClient] Workload unavailable while ${options.description}; retrying in ${effectiveDelayMs}ms`,
      );
      await sleepWithSignal(effectiveDelayMs, options.signal);
      delayMs = Math.min(delayMs * 2, WORKLOAD_READY_MAX_DELAY_MS);
    }
  }
}

export function deriveBlaxelSandboxName(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `roomote-${digest.slice(0, 32)}`;
}
