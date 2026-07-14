import { getTaskSummary } from './tasks-api-client.js';
import { getHarnessLabel, getTaskStatusLabel } from './task-display.js';
import { catchError, textResult } from './tool-result.js';
import type {
  RoomoteConfig,
  TaskSummaryResponse,
  ToolResult,
} from './types.js';

/** Default wait budget for environment prepare / verification boots. */
const DEFAULT_AWAIT_TASK_TIMEOUT_MS = 25 * 60_000;
const MIN_AWAIT_TASK_TIMEOUT_MS = 5_000;
const MAX_AWAIT_TASK_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_AWAIT_TASK_POLL_INTERVAL_MS = 5_000;
const MIN_AWAIT_TASK_POLL_INTERVAL_MS = 1_000;
const MAX_AWAIT_TASK_POLL_INTERVAL_MS = 60_000;
/**
 * Grace window for consecutive failed status polls. A single failed read
 * (platform-API stall, a rolling restart, or a launch/enqueue race before the
 * run row exists) must not abort a multi-minute await, so transient failures
 * are absorbed and the poll is retried. Only once reads keep failing for this
 * long — well under the overall wait budget — is the failure surfaced as a
 * retryable tool error instead of silently burning the full timeout.
 */
const MAX_CONSECUTIVE_POLL_ERROR_MS = 2 * 60_000;

type AwaitTaskTerminalLabel =
  | 'Completed'
  | 'Failed'
  | 'Canceled'
  | 'TimedOut'
  | 'NeedsInput'
  | 'Ready'
  | 'Idle';

type AwaitTaskResult = {
  taskId: string;
  title: string | null;
  status: string;
  terminalLabel: AwaitTaskTerminalLabel;
  ready: boolean;
  timedOut: boolean;
  waitedMs: number;
  errorSummary: string | null;
  taskRunStatus: string | null;
  taskPhase: string | null;
  completed: boolean;
  harness: string | null;
  linkedEnvironmentId: string | null;
  linkedEnvironmentName: string | null;
};

type AwaitTaskDeps = {
  getTaskSummary: typeof getTaskSummary;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: AwaitTaskDeps = {
  getTaskSummary,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const TERMINAL_EXITED = new Set(['failed', 'canceled', 'completed']);

/**
 * Whether the target task is still usefully in-flight for `await`.
 * Settled Ready/Idle (post-turn keepalive) is not active — environments that
 * finish a one-shot verification turn look Idle/Ready, not Failed/Completed.
 * Prefer the latest run's terminal status when it conflicts with the aggregate
 * completed flag (failed/canceled resumes can leave completed=true).
 */
export function isTaskActiveForAwait(summary: TaskSummaryResponse): boolean {
  const status = summary.taskRunStatus;

  // Latest run status always wins: a failed/canceled (or status-completed) run
  // is settled even when the task aggregate completed flag is inconsistent.
  if (status && TERMINAL_EXITED.has(status)) {
    return false;
  }

  if (summary.completed) {
    return false;
  }

  if (!status) {
    // No run row yet: keep waiting a bit during enqueue.
    return true;
  }

  const phase = summary.taskPhase;

  if (phase === 'waiting_for_user_input') {
    return false;
  }

  if (status === 'idle') {
    // Follow-up turn mid-flight while row stays Idle.
    return phase === 'running';
  }

  if (status === 'running') {
    // waiting_for_prompt / idle phase => Ready/Idle labels (turn ended).
    // stopped / shutting_down usually precede a final failed/canceled/idle
    // status transition — keep polling instead of treating them as ready.
    if (phase === 'waiting_for_prompt' || phase === 'idle') {
      return false;
    }
    // null/unknown, running, stopped, shutting_down: still active.
    return true;
  }

  // Booting statuses (pending, preparing, spawning, connecting, ...) → active.
  return true;
}

export function classifySettledSummary(
  summary: TaskSummaryResponse,
): Pick<AwaitTaskResult, 'terminalLabel' | 'ready' | 'errorSummary'> {
  const statusLabel = getTaskStatusLabel(summary);
  const errorSummary = summary.taskRunError?.trim()
    ? summary.taskRunError.trim()
    : null;

  // Prefer the latest run terminal status over the aggregate completed flag so
  // a failed/canceled resume is never reported as a successful completion.
  if (summary.taskRunStatus === 'failed') {
    return {
      terminalLabel: 'Failed',
      ready: false,
      errorSummary: errorSummary ?? 'Task run failed',
    };
  }

  if (summary.taskRunStatus === 'canceled') {
    return {
      terminalLabel: 'Canceled',
      ready: false,
      errorSummary: errorSummary ?? 'Task was canceled',
    };
  }

  if (summary.taskRunStatus === 'completed' || summary.completed) {
    return {
      terminalLabel: 'Completed',
      ready: !errorSummary,
      errorSummary,
    };
  }

  if (
    summary.taskPhase === 'waiting_for_user_input' ||
    statusLabel === 'Needs input'
  ) {
    return {
      terminalLabel: 'NeedsInput',
      ready: false,
      errorSummary:
        errorSummary ??
        'Task is waiting for user input instead of completing verification',
    };
  }

  if (statusLabel === 'Idle' || summary.taskPhase === 'idle') {
    return {
      terminalLabel: 'Idle',
      ready: !errorSummary,
      errorSummary,
    };
  }

  if (statusLabel === 'Ready' || summary.taskPhase === 'waiting_for_prompt') {
    return {
      terminalLabel: 'Ready',
      ready: !errorSummary,
      errorSummary,
    };
  }

  // Fallback for unexpected settled shapes — never claim ready here.
  return {
    terminalLabel: statusLabel === 'Failed' ? 'Failed' : 'Idle',
    ready: false,
    errorSummary:
      errorSummary ??
      `Task settled in an unexpected state (${statusLabel}) and readiness was not confirmed`,
  };
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function formatAwaitResult(result: AwaitTaskResult): string {
  const harnessLabel = getHarnessLabel(result.harness);
  const lines = [
    `Task: ${result.title || '(untitled)'}`,
    `ID: ${result.taskId}`,
    `Status: ${result.status}`,
    `Terminal: ${result.terminalLabel}`,
    `Ready: ${result.ready ? 'yes' : 'no'}`,
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Waited: ${Math.round(result.waitedMs / 1000)}s`,
    result.errorSummary ? `Error: ${result.errorSummary}` : null,
    harnessLabel ? `Harness: ${harnessLabel}` : null,
    result.linkedEnvironmentName
      ? `Linked Environment: ${result.linkedEnvironmentName}`
      : null,
    result.linkedEnvironmentId
      ? `Linked Environment ID: ${result.linkedEnvironmentId}`
      : null,
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Blocks the current tool call, polling the task summary until it settles or
 * the timeout elapses. Holding one tool call open for minutes is deliberate and
 * only safe because of two OpenCode-runtime properties: the client waits on an
 * MCP tool indefinitely (no per-call request timeout), and the turn-stall
 * watchdog re-arms instead of aborting while a tool part is still `running`. If
 * either assumption changes, this long block needs its own keepalive.
 */
export async function awaitTaskSettlement(
  params: {
    taskId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
  config: RoomoteConfig,
  deps: AwaitTaskDeps = defaultDeps,
): Promise<AwaitTaskResult> {
  const taskId = params.taskId.trim();
  const timeoutMs = clamp(
    params.timeoutMs,
    DEFAULT_AWAIT_TASK_TIMEOUT_MS,
    MIN_AWAIT_TASK_TIMEOUT_MS,
    MAX_AWAIT_TASK_TIMEOUT_MS,
  );
  const pollIntervalMs = clamp(
    params.pollIntervalMs,
    DEFAULT_AWAIT_TASK_POLL_INTERVAL_MS,
    MIN_AWAIT_TASK_POLL_INTERVAL_MS,
    MAX_AWAIT_TASK_POLL_INTERVAL_MS,
  );

  const startedAt = deps.now();
  let lastSummary: TaskSummaryResponse | null = null;
  let firstPollErrorAt: number | null = null;
  let lastPollError: Error | null = null;

  while (true) {
    let summary: TaskSummaryResponse;
    try {
      summary = await deps.getTaskSummary(config, taskId);
    } catch (error) {
      // A single failed poll must not abort a multi-minute await. Absorb
      // transient read failures and keep polling; surface only once failures
      // persist past the grace window or the overall budget runs out.
      lastPollError = error instanceof Error ? error : new Error(String(error));
      const erroredAt = deps.now();
      if (firstPollErrorAt === null) {
        firstPollErrorAt = erroredAt;
      }

      const elapsed = erroredAt - startedAt;
      if (elapsed >= timeoutMs) {
        break;
      }

      const erroringForMs = erroredAt - firstPollErrorAt;
      if (erroringForMs >= Math.min(MAX_CONSECUTIVE_POLL_ERROR_MS, timeoutMs)) {
        throw new Error(
          `Unable to read task ${taskId} status for ${Math.round(
            erroringForMs / 1000,
          )}s: ${lastPollError.message}`,
        );
      }

      await deps.sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
      continue;
    }

    // A successful read clears any transient-failure streak.
    firstPollErrorAt = null;
    lastPollError = null;
    lastSummary = summary;

    if (!isTaskActiveForAwait(summary)) {
      const classified = classifySettledSummary(summary);
      return {
        taskId: summary.id,
        title: summary.title,
        status: getTaskStatusLabel(summary),
        terminalLabel: classified.terminalLabel,
        ready: classified.ready,
        timedOut: false,
        waitedMs: deps.now() - startedAt,
        errorSummary: classified.errorSummary,
        taskRunStatus: summary.taskRunStatus,
        taskPhase: summary.taskPhase,
        completed: summary.completed,
        harness: summary.harness,
        linkedEnvironmentId: summary.linkedEnvironmentId,
        linkedEnvironmentName: summary.linkedEnvironmentName,
      };
    }

    const elapsed = deps.now() - startedAt;
    if (elapsed >= timeoutMs) {
      break;
    }

    const remaining = timeoutMs - elapsed;
    await deps.sleep(Math.min(pollIntervalMs, remaining));
  }

  const summary =
    lastSummary ??
    (await deps.getTaskSummary(config, taskId).catch(() => null));

  if (!summary) {
    return {
      taskId,
      title: null,
      status: 'TimedOut',
      terminalLabel: 'TimedOut',
      ready: false,
      timedOut: true,
      waitedMs: deps.now() - startedAt,
      errorSummary: lastPollError
        ? `Timed out after ${timeoutMs}ms; last status read for task ${taskId} failed: ${lastPollError.message}`
        : `Timed out after ${timeoutMs}ms waiting for task ${taskId}`,
      taskRunStatus: null,
      taskPhase: null,
      completed: false,
      harness: null,
      linkedEnvironmentId: null,
      linkedEnvironmentName: null,
    };
  }

  return {
    taskId: summary.id,
    title: summary.title,
    status: getTaskStatusLabel(summary),
    terminalLabel: 'TimedOut',
    ready: false,
    timedOut: true,
    waitedMs: deps.now() - startedAt,
    errorSummary:
      summary.taskRunError?.trim() ||
      `Timed out after ${timeoutMs}ms while task was still active (status: ${getTaskStatusLabel(summary)})`,
    taskRunStatus: summary.taskRunStatus,
    taskPhase: summary.taskPhase,
    completed: summary.completed,
    harness: summary.harness,
    linkedEnvironmentId: summary.linkedEnvironmentId,
    linkedEnvironmentName: summary.linkedEnvironmentName,
  };
}

export async function handleAwaitTask(
  params: {
    taskId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
  config: RoomoteConfig,
  deps?: AwaitTaskDeps,
): Promise<ToolResult> {
  try {
    const result = await awaitTaskSettlement(params, config, deps);
    return textResult(formatAwaitResult(result));
  } catch (error) {
    return catchError(error);
  }
}
