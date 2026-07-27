import { randomUUID } from 'node:crypto';

import { MODAL_CAPABILITIES as MODAL_CAPABILITIES_VALUE } from '@roomote/types';

import type { ComputeProvider } from '@roomote/types';

import type {
  CommandOutputEvent,
  ComputeProviderCapabilities,
  ComputeProviderClient,
  CreateInstanceInput,
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreatedInstance,
  DestroyInstanceInput,
  DestroyInstanceResult,
  GetCommandOutputInput,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ResumeInstanceInput,
  RoomoteBrokerConfig,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';
import { unsupported } from '../errors';
import { throwIfAborted, toAbortError } from '../modal/abort';
import { RoomoteBrokerExec } from './roomote-broker-exec';
import {
  BrokerRequestError,
  RoomoteBrokerTransport,
} from './roomote-broker-transport';

export { BrokerRequestError } from './roomote-broker-transport';

const SNAPSHOT_POLL_INTERVAL_MS = 5_000;
const SNAPSHOT_POLL_TIMEOUT_MS = 25 * 60_000;
// Keep each request's decoded file payload under the broker's 24 MiB cap.
const FILE_BATCH_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Broker-backed engine for the deployment-managed `roomote` provider. The
 * deployment holds no Modal credentials; every sandbox operation is an
 * HMAC-signed HTTP request to the hosting operator's compute broker, which
 * owns the sole Modal token and enforces per-tenant scoping server-side.
 *
 * Behavioral reference: the direct Modal adapter (`./modal.ts`) — command,
 * detached-exit, and snapshot semantics must match it so the modal→broker
 * flip is invisible to the controller.
 */
export class RoomoteBrokerClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'roomote';

  public readonly capabilities: ComputeProviderCapabilities =
    MODAL_CAPABILITIES_VALUE;

  private readonly transport: RoomoteBrokerTransport;

  private readonly exec: RoomoteBrokerExec;

  public constructor(private readonly config: RoomoteBrokerConfig) {
    if (!config.brokerUrl || !config.tenantId || !config.brokerKey) {
      throw new Error(
        'The broker backend requires brokerUrl, tenantId, and brokerKey',
      );
    }

    if (!config.baseImageRef) {
      throw new Error(
        'The broker backend requires an explicit baseImageRef for fresh sandboxes',
      );
    }

    this.transport = new RoomoteBrokerTransport(config);
    this.exec = new RoomoteBrokerExec(
      (input) => this.transport.request(input),
      (input) => this.transport.requestJson(input),
      config.timeoutMs,
    );

    console.log(
      `[RoomoteBrokerClient] Initialized ${JSON.stringify({
        brokerUrl: config.brokerUrl,
        tenantId: config.tenantId,
        baseImageRef: config.baseImageRef,
        regions: config.regions ?? '(default)',
        timeoutMs: config.timeoutMs ?? '(default)',
      })}`,
    );
  }

  public async listInstances(
    input: ListInstancesInput,
  ): Promise<InstanceSummary[]> {
    const payload = (await this.requestJson({
      method: 'GET',
      path: '/v1/sandboxes',
      signal: input.signal,
    })) as { instances: { instanceId: string; status: string }[] };

    return payload.instances.map((instance) => ({
      instanceId: instance.instanceId,
      status: instance.status === 'running' ? 'running' : 'stopped',
      timeoutRemainingMs: 0,
    }));
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    try {
      const payload = (await this.requestJson({
        method: 'GET',
        path: `/v1/sandboxes/${encodeURIComponent(input.instanceId)}`,
        signal: input.signal,
      })) as { status: string };

      return { status: payload.status === 'running' ? 'running' : 'stopped' };
    } catch (error) {
      if (error instanceof BrokerRequestError && error.status === 404) {
        return { status: 'stopped' };
      }

      throw error;
    }
  }

  public async createInstance(
    input: CreateInstanceInput,
  ): Promise<CreatedInstance> {
    return this.launchInstance(input, undefined);
  }

  public async resumeFromSnapshot(
    input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    return this.launchInstance(input, input.sourceSnapshotId);
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    await this.requestJson({
      method: 'DELETE',
      path: `/v1/sandboxes/${encodeURIComponent(input.instanceId)}`,
      signal: input.signal,
    });

    return {};
  }

  public async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    throwIfAborted(input.signal);
    return this.exec.run(input);
  }

  public streamCommandOutput(
    _input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    unsupported(this.vendor, 'streamCommandOutput');
  }

  public getCommandOutput(_input: GetCommandOutputInput): Promise<string> {
    unsupported(this.vendor, 'getCommandOutput');
  }

  public async writeFiles(input: WriteFileInput): Promise<void> {
    throwIfAborted(input.signal);

    const batches: { path: string; contentBase64: string }[][] = [];
    let batch: { path: string; contentBase64: string }[] = [];
    let batchBytes = 0;

    for (const file of input.files) {
      if (
        batch.length > 0 &&
        batchBytes + file.content.byteLength > FILE_BATCH_MAX_BYTES
      ) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }

      batch.push({
        path: file.path,
        contentBase64: file.content.toString('base64'),
      });
      batchBytes += file.content.byteLength;
    }

    if (batch.length > 0) {
      batches.push(batch);
    }

    for (const files of batches) {
      await this.requestJson({
        method: 'PUT',
        path: `/v1/sandboxes/${encodeURIComponent(input.instanceId)}/files`,
        body: JSON.stringify({ files }),
        signal: input.signal,
      });
    }
  }

  public async createSnapshot(
    input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throwIfAborted(input.signal);

    const accepted = (await this.requestJson({
      method: 'POST',
      path: `/v1/sandboxes/${encodeURIComponent(input.instanceId)}/snapshot`,
      signal: input.signal,
    })) as { operationId: string };

    const deadline = Date.now() + SNAPSHOT_POLL_TIMEOUT_MS;

    while (true) {
      throwIfAborted(input.signal);

      if (Date.now() > deadline) {
        throw new Error(
          `Snapshot operation ${accepted.operationId} for ${input.instanceId} timed out`,
        );
      }

      const operation = (await this.requestJson({
        method: 'GET',
        path: `/v1/operations/${encodeURIComponent(accepted.operationId)}`,
        signal: input.signal,
      })) as { status: string; snapshotId?: string; error?: string };

      if (operation.status === 'succeeded' && operation.snapshotId) {
        // Record the id before returning. The broker has already snapshotted
        // and torn down the sandbox by this point, so a stall between here
        // and the caller's write loses the only handle to that snapshot.
        await input.onSnapshotCreated?.(operation.snapshotId);

        return { snapshotId: operation.snapshotId };
      }

      if (operation.status === 'failed') {
        throw new Error(
          `Snapshot of ${input.instanceId} failed: ${operation.error ?? 'unknown error'}`,
        );
      }

      await sleep(SNAPSHOT_POLL_INTERVAL_MS, input.signal);
    }
  }

  private async launchInstance(
    input: CreateInstanceInput,
    sourceSnapshotId: string | undefined,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const body = JSON.stringify({
      ...(sourceSnapshotId
        ? { snapshotId: sourceSnapshotId }
        : { imageRef: this.config.baseImageRef }),
      ...(input.ports?.length ? { ports: input.ports } : {}),
      ...(input.tags && Object.keys(input.tags).length > 0
        ? { tags: input.tags }
        : {}),
      ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
      ...(this.config.cpu ? { cpu: this.config.cpu } : {}),
      ...(this.config.cpuLimit ? { cpuLimit: this.config.cpuLimit } : {}),
      ...(this.config.memoryMiB ? { memoryMiB: this.config.memoryMiB } : {}),
      ...(this.config.memoryLimitMiB
        ? { memoryLimitMiB: this.config.memoryLimitMiB }
        : {}),
      ...(this.config.regions?.length ? { regions: this.config.regions } : {}),
      ...(this.config.vmRuntime ? { vmRuntime: true } : {}),
    });

    try {
      const created = (await this.requestJson({
        method: 'POST',
        path: '/v1/sandboxes',
        body,
        signal: input.signal,
        headers: { 'idempotency-key': idempotencyKey },
      })) as {
        instanceId: string;
        domains?: Record<string, string>;
      };

      return {
        instanceId: created.instanceId,
        status: 'running',
        ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
        ...(created.domains ? { domains: created.domains } : {}),
      };
    } catch (error) {
      // The broker may have completed the create after a local abort. Replay
      // the idempotent request without a signal and terminate the orphan.
      if (isAbortLike(error)) {
        this.reconcileAbortedCreate(idempotencyKey, body);
        throw toAbortError(
          input.signal,
          'Creating a broker sandbox was aborted',
        );
      }

      throw error;
    }
  }

  private reconcileAbortedCreate(idempotencyKey: string, body: string): void {
    void (async () => {
      const created = (await this.requestJson({
        method: 'POST',
        path: '/v1/sandboxes',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      })) as { instanceId: string };

      console.warn(
        `[RoomoteBrokerClient] Terminating sandbox created after abort ${JSON.stringify(
          { instanceId: created.instanceId },
        )}`,
      );

      await this.requestJson({
        method: 'DELETE',
        path: `/v1/sandboxes/${encodeURIComponent(created.instanceId)}`,
      });
    })().catch((error: unknown) => {
      console.warn(
        `[RoomoteBrokerClient] Aborted-create reconciliation failed (orphan recovery will cover it): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async requestJson(input: {
    method: string;
    path: string;
    body?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  }): Promise<unknown> {
    return this.transport.requestJson(input);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(toAbortError(signal));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
