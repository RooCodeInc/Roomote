import { createHash, createHmac, randomUUID } from 'node:crypto';

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

const DETACHED_EXIT_GRACE_PERIOD_MS = 1_000;
const SNAPSHOT_POLL_INTERVAL_MS = 5_000;
const SNAPSHOT_POLL_TIMEOUT_MS = 25 * 60_000;
const EXIT_POLL_INTERVAL_MS = 30_000;
const EXIT_POLL_MAX_MS = 6 * 60 * 60_000;
// Keep each request's decoded file payload under the broker's 24 MiB cap.
const FILE_BATCH_MAX_BYTES = 16 * 1024 * 1024;

export class BrokerRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BrokerRequestError';
  }
}

type BrokerExecEvent =
  | { type: 'started'; execId: string }
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }
  | { type: 'heartbeat' };

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

  private readonly fetchImpl: typeof fetch;

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

    this.fetchImpl = config.fetchImpl ?? fetch;

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

    const response = await this.request({
      method: 'POST',
      path: `/v1/sandboxes/${encodeURIComponent(input.instanceId)}/exec`,
      body: JSON.stringify({
        cmd: input.cmd,
        ...(input.args?.length ? { args: input.args } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      }),
      signal: input.signal,
    });

    const events = new ExecEventPump(iterateNdjson<BrokerExecEvent>(response));

    if (!input.detached) {
      const outcome = await consumeExecEvents(events);

      if (outcome.error !== undefined) {
        throw new Error(outcome.error);
      }

      return finishCommandResult(outcome, input);
    }

    // Detached: report a grace-period exit synchronously (bootstrap failures
    // surface immediately); otherwise keep consuming in the background and
    // deliver onExit — falling back to status polling if the stream drops.
    const graceOutcome = await consumeExecEvents(
      events,
      DETACHED_EXIT_GRACE_PERIOD_MS,
    );

    if (graceOutcome.error !== undefined) {
      throw new Error(graceOutcome.error);
    }

    if (graceOutcome.exitCode !== null) {
      console.warn(
        `[RoomoteBrokerClient] Detached command exited during grace period ${JSON.stringify(
          {
            instanceId: input.instanceId,
            cmd: input.cmd,
            exitCode: graceOutcome.exitCode,
          },
        )}`,
      );

      return finishCommandResult(graceOutcome, input);
    }

    this.watchDetachedCommand(input, graceOutcome);

    return { commandId: undefined, exitCode: null };
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

  /**
   * Background consumption of a detached command: pipe output to logs and
   * fire onExit when the process ends. If the stream drops before the exit
   * event, recover the exit code by polling the broker's exec-session
   * status — the controller's bootstrap-restart classification depends on
   * that callback arriving.
   */
  private watchDetachedCommand(
    input: RunCommandInput,
    grace: ExecOutcome,
  ): void {
    const label = `broker:${input.instanceId}`;

    void (async () => {
      const streamed = await consumeExecEvents(grace.remaining, undefined, {
        onOutput: (event) => {
          for (const line of event.data.trimEnd().split('\n')) {
            console.log(`[${label}:${event.stream}] ${line}`);
          }
        },
      }).catch(() => undefined);

      let exitCode = streamed?.exitCode ?? null;

      if (exitCode === null && grace.execId) {
        exitCode = await this.pollForExit(input.instanceId, grace.execId);
      }

      if (exitCode === null) {
        console.warn(
          `[${label}] Lost track of detached command ${grace.execId ?? '(unknown)'}; onExit will not fire`,
        );
        return;
      }

      console.log(`[${label}] Detached process exited with code ${exitCode}`);
      await input.onExit?.({ exitCode });
    })().catch((error: unknown) => {
      console.warn(
        `[${label}] Detached exit handler error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async pollForExit(
    instanceId: string,
    execId: string,
  ): Promise<number | null> {
    const deadline =
      Date.now() +
      Math.min(this.config.timeoutMs ?? EXIT_POLL_MAX_MS, EXIT_POLL_MAX_MS);

    while (Date.now() < deadline) {
      await sleep(EXIT_POLL_INTERVAL_MS);

      try {
        const status = (await this.requestJson({
          method: 'GET',
          path: `/v1/sandboxes/${encodeURIComponent(instanceId)}/exec/${encodeURIComponent(execId)}`,
        })) as { status: string; exitCode: number | null };

        if (status.status === 'exited' && status.exitCode !== null) {
          return status.exitCode;
        }

        if (status.status === 'failed') {
          return null;
        }
      } catch (error) {
        if (error instanceof BrokerRequestError && error.status === 404) {
          return null;
        }

        // Transient broker/network errors: keep polling until the deadline.
      }
    }

    return null;
  }

  private async requestJson(input: {
    method: string;
    path: string;
    body?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  }): Promise<unknown> {
    const response = await this.request(input);
    return response.json() as Promise<unknown>;
  }

  private async request(input: {
    method: string;
    path: string;
    body?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  }): Promise<Response> {
    throwIfAborted(input.signal);

    const url = new URL(this.config.brokerUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${input.path}`;

    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const body = input.body ?? '';
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', this.config.brokerKey)
      .update(
        [
          timestamp,
          nonce,
          input.method.toUpperCase(),
          url.pathname + url.search,
          bodyHash,
        ].join('\n'),
      )
      .digest('hex');

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          'content-type': 'application/json',
          'x-roomote-tenant': this.config.tenantId,
          'x-roomote-timestamp': timestamp,
          'x-roomote-nonce': nonce,
          'x-roomote-signature': signature,
          ...(input.headers ?? {}),
        },
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (isAbortLike(error)) {
        throw toAbortError(
          input.signal,
          `Broker request ${input.method} ${input.path} was aborted`,
        );
      }

      throw error;
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; code?: string }
        | undefined;

      throw new BrokerRequestError(
        payload?.error ??
          `Broker request ${input.method} ${input.path} failed with HTTP ${response.status}`,
        response.status,
        payload?.code ?? 'unknown_error',
      );
    }

    return response;
  }
}

/**
 * Single-consumer wrapper around the exec event stream. Racing a raw
 * generator's next() against a timer would drop the in-flight event when the
 * timer wins; the pump keeps that pending read and hands it to the next
 * consumer instead.
 */
class ExecEventPump {
  private pending: Promise<IteratorResult<BrokerExecEvent>> | undefined;

  public constructor(
    private readonly events: AsyncGenerator<BrokerExecEvent>,
  ) {}

  public next(): Promise<IteratorResult<BrokerExecEvent>> {
    const result = this.pending ?? this.events.next();
    this.pending = undefined;
    return result;
  }

  /** Resolves 'timeout' without consuming the in-flight event. */
  public async nextWithTimeout(
    timeoutMs: number,
  ): Promise<IteratorResult<BrokerExecEvent> | 'timeout'> {
    this.pending ??= this.events.next();
    const pending = this.pending;
    const winner = await Promise.race([
      pending.then((result) => ({ kind: 'result' as const, result })),
      sleep(timeoutMs).then(() => ({ kind: 'timeout' as const })),
    ]);

    if (winner.kind === 'timeout') {
      return 'timeout';
    }

    this.pending = undefined;
    return winner.result;
  }
}

type ExecOutcome = {
  execId: string | undefined;
  exitCode: number | null;
  error: string | undefined;
  stdout: string;
  stderr: string;
  /** Continues where consumption stopped (grace-period handoff). */
  remaining: ExecEventPump;
};

async function consumeExecEvents(
  events: ExecEventPump,
  graceMs?: number,
  hooks?: { onOutput?: (event: CommandOutputEvent) => void },
): Promise<ExecOutcome> {
  const outcome: ExecOutcome = {
    execId: undefined,
    exitCode: null,
    error: undefined,
    stdout: '',
    stderr: '',
    remaining: events,
  };
  const deadline = graceMs !== undefined ? Date.now() + graceMs : undefined;

  while (true) {
    let result: IteratorResult<BrokerExecEvent>;

    if (deadline !== undefined) {
      const timeLeft = deadline - Date.now();

      if (timeLeft <= 0) {
        return outcome;
      }

      const raced = await events.nextWithTimeout(timeLeft);

      if (raced === 'timeout') {
        return outcome;
      }

      result = raced;
    } else {
      result = await events.next();
    }

    if (result.done) {
      return outcome;
    }

    const event = result.value;

    switch (event.type) {
      case 'started':
        outcome.execId = event.execId;
        break;
      case 'stdout':
        outcome.stdout += event.data;
        hooks?.onOutput?.({ stream: 'stdout', data: event.data });
        break;
      case 'stderr':
        outcome.stderr += event.data;
        hooks?.onOutput?.({ stream: 'stderr', data: event.data });
        break;
      case 'exit':
        outcome.exitCode = event.exitCode;
        return outcome;
      case 'error':
        outcome.error = event.message;
        return outcome;
      case 'heartbeat':
        break;
    }
  }
}

/**
 * Matches the direct Modal adapter's contract: output is delivered to
 * onOutput as one aggregated call per non-empty stream, after exit.
 */
function finishCommandResult(
  outcome: ExecOutcome,
  input: RunCommandInput,
): RunCommandResult {
  const stdout = outcome.stdout || undefined;
  const stderr = outcome.stderr || undefined;

  if (input.onOutput) {
    if (stdout) {
      input.onOutput({ stream: 'stdout', data: stdout });
    }

    if (stderr) {
      input.onOutput({ stream: 'stderr', data: stderr });
    }
  }

  return {
    commandId: undefined,
    exitCode: outcome.exitCode,
    stdout,
    stderr,
  };
}

async function* iterateNdjson<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (value) {
        buffered += decoder.decode(value, { stream: true });

        let newlineIndex: number;

        while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);

          if (line) {
            yield JSON.parse(line) as T;
          }
        }
      }

      if (done) {
        break;
      }
    }

    const tail = buffered.trim();

    if (tail) {
      yield JSON.parse(tail) as T;
    }
  } finally {
    reader.releaseLock();
  }
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
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
