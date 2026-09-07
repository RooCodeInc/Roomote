import type {
  CommandOutputEvent,
  RunCommandInput,
  RunCommandResult,
} from '../types';
import { toAbortError } from '../modal/abort';
import {
  BrokerRequestError,
  type BrokerRequestInput,
} from './roomote-broker-transport';

const DETACHED_EXIT_GRACE_PERIOD_MS = 1_000;
const EXIT_POLL_INTERVAL_MS = 30_000;
const EXIT_POLL_MAX_MS = 6 * 60 * 60_000;

type BrokerExecEvent =
  | { type: 'started'; execId: string }
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }
  | { type: 'heartbeat' };

type Request = (input: BrokerRequestInput) => Promise<Response>;
type RequestJson = (input: BrokerRequestInput) => Promise<unknown>;

/** Preserves Modal-compatible exec semantics over the broker NDJSON protocol. */
export class RoomoteBrokerExec {
  public constructor(
    private readonly request: Request,
    private readonly requestJson: RequestJson,
    private readonly timeoutMs: number | undefined,
  ) {}

  public async run(input: RunCommandInput): Promise<RunCommandResult> {
    const detachedRequest = input.detached
      ? createDetachedRequestSignal(input.signal)
      : undefined;

    try {
      const response = await this.request({
        method: 'POST',
        path: `/v1/sandboxes/${encodeURIComponent(input.instanceId)}/exec`,
        body: JSON.stringify({
          cmd: input.cmd,
          ...(input.args?.length ? { args: input.args } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { env: input.env } : {}),
        }),
        signal: detachedRequest?.signal ?? input.signal,
      });
      const events = new ExecEventPump(
        iterateNdjson<BrokerExecEvent>(response),
      );

      if (!input.detached) {
        const outcome = await consumeExecEvents(events);
        if (outcome.error !== undefined) {
          deliverOutput(outcome, input.onOutput);
          throw new Error(outcome.error);
        }
        return finishCommandResult(outcome, input);
      }

      const graceOutcome = await consumeExecEvents(
        events,
        DETACHED_EXIT_GRACE_PERIOD_MS,
      );
      if (graceOutcome.error !== undefined) {
        deliverOutput(graceOutcome, input.onOutput);
        throw new Error(graceOutcome.error);
      }
      if (graceOutcome.exitCode !== null) {
        console.warn(
          `[RoomoteBrokerClient] Detached command exited during grace period ${JSON.stringify({ instanceId: input.instanceId, cmd: input.cmd, exitCode: graceOutcome.exitCode })}`,
        );
        return finishCommandResult(graceOutcome, input);
      }

      // The caller's timeout only bounds launch. Once detached execution is
      // established, keep the broker stream alive for runtime diagnostics.
      detachedRequest?.detach();
      deliverOutput(graceOutcome, input.onOutput);
      this.watchDetachedCommand(input, graceOutcome);
      return { commandId: graceOutcome.execId, exitCode: null };
    } finally {
      detachedRequest?.detach();
    }
  }

  private watchDetachedCommand(
    input: RunCommandInput,
    grace: ExecOutcome,
  ): void {
    const label = `broker:${input.instanceId}`;
    void (async () => {
      const streamed = await consumeExecEvents(grace.remaining, undefined, {
        tolerateStreamErrors: true,
        onOutput: (event) => {
          input.onOutput?.(event);
          for (const line of event.data.trimEnd().split('\n')) {
            console.log(`[${label}:${event.stream}] ${line}`);
          }
        },
      });
      if (streamed.error) {
        input.onOutput?.({
          stream: 'stderr',
          data: `Broker exec error: ${streamed.error}\n`,
        });
      }
      const execId = streamed.execId ?? grace.execId;
      let exitCode = streamed.exitCode;
      if (exitCode === null && execId) {
        exitCode = await this.pollForExit(input.instanceId, execId);
      }
      if (exitCode === null) {
        console.warn(
          `[${label}] Lost track of detached command ${execId ?? '(unknown)'}; onExit will not fire`,
        );
        return;
      }
      console.log(`[${label}] Detached process exited with code ${exitCode}`);
      await input.onExit?.({ exitCode });
    })().catch((error: unknown) => {
      console.warn(
        `[${label}] Detached exit handler error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async pollForExit(
    instanceId: string,
    execId: string,
  ): Promise<number | null> {
    const deadline =
      Date.now() +
      Math.min(this.timeoutMs ?? EXIT_POLL_MAX_MS, EXIT_POLL_MAX_MS);
    while (Date.now() < deadline) {
      await sleep(EXIT_POLL_INTERVAL_MS);
      try {
        const status = (await this.requestJson({
          method: 'GET',
          path: `/v1/sandboxes/${encodeURIComponent(instanceId)}/exec/${encodeURIComponent(execId)}`,
        })) as { status: string; exitCode: number | null };
        if (status.status === 'exited' && status.exitCode !== null)
          return status.exitCode;
        if (status.status === 'failed') return null;
      } catch (error) {
        if (error instanceof BrokerRequestError && error.status === 404)
          return null;
      }
    }
    return null;
  }
}

function createDetachedRequestSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  detach: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);

  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    detach: () => signal?.removeEventListener('abort', onAbort),
  };
}

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
  public async nextWithTimeout(
    timeoutMs: number,
  ): Promise<IteratorResult<BrokerExecEvent> | 'timeout'> {
    this.pending ??= this.events.next();
    const pending = this.pending;
    const winner = await Promise.race([
      pending.then((result) => ({ kind: 'result' as const, result })),
      sleep(timeoutMs).then(() => ({ kind: 'timeout' as const })),
    ]);
    if (winner.kind === 'timeout') return 'timeout';
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
  remaining: ExecEventPump;
};

async function consumeExecEvents(
  events: ExecEventPump,
  graceMs?: number,
  hooks?: {
    onOutput?: (event: CommandOutputEvent) => void;
    tolerateStreamErrors?: boolean;
  },
): Promise<ExecOutcome> {
  const outcome: ExecOutcome = {
    execId: undefined,
    exitCode: null,
    error: undefined,
    stdout: '',
    stderr: '',
    remaining: events,
  };
  const deadline = graceMs === undefined ? undefined : Date.now() + graceMs;
  while (true) {
    let result: IteratorResult<BrokerExecEvent>;
    try {
      if (deadline === undefined) result = await events.next();
      else {
        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) return outcome;
        const raced = await events.nextWithTimeout(timeLeft);
        if (raced === 'timeout') return outcome;
        result = raced;
      }
    } catch (error) {
      if (hooks?.tolerateStreamErrors) return outcome;
      outcome.error = error instanceof Error ? error.message : String(error);
      return outcome;
    }
    if (result.done) return outcome;
    switch (result.value.type) {
      case 'started':
        outcome.execId = result.value.execId;
        break;
      case 'stdout':
        outcome.stdout += result.value.data;
        hooks?.onOutput?.({ stream: 'stdout', data: result.value.data });
        break;
      case 'stderr':
        outcome.stderr += result.value.data;
        hooks?.onOutput?.({ stream: 'stderr', data: result.value.data });
        break;
      case 'exit':
        outcome.exitCode = result.value.exitCode;
        return outcome;
      case 'error':
        outcome.error = result.value.message;
        return outcome;
      case 'heartbeat':
        break;
    }
  }
}

function finishCommandResult(
  outcome: ExecOutcome,
  input: RunCommandInput,
): RunCommandResult {
  const stdout = outcome.stdout || undefined;
  const stderr = outcome.stderr || undefined;
  deliverOutput(outcome, input.onOutput);
  return {
    commandId: outcome.execId,
    exitCode: outcome.exitCode,
    stdout,
    stderr,
  };
}

function deliverOutput(
  outcome: Pick<ExecOutcome, 'stdout' | 'stderr'>,
  onOutput: RunCommandInput['onOutput'],
): void {
  if (!onOutput) return;
  if (outcome.stdout) onOutput({ stream: 'stdout', data: outcome.stdout });
  if (outcome.stderr) onOutput({ stream: 'stderr', data: outcome.stderr });
}

async function* iterateNdjson<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) return;
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
          if (line) yield JSON.parse(line) as T;
        }
      }
      if (done) break;
    }
    const tail = buffered.trim();
    if (tail) yield JSON.parse(tail) as T;
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
