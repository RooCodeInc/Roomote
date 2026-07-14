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
 */
export function isTaskActiveForAwait(summary: TaskSummaryResponse): boolean {
  if (summary.completed) {
    return false;
  }

  const status = summary.taskRunStatus;

  if (!status) {
    // No run row yet: keep waiting a bit during enqueue.
    return true;
  }

  if (TERMINAL_EXITED.has(status)) {
    return false;
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
    if (
      phase === 'waiting_for_prompt' ||
      phase === 'idle' ||
      phase === 'stopped' ||
      phase === 'shutting_down'
    ) {
      return false;
    }
    // null/unknown or running/working phases: still active.
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

  if (summary.completed || summary.taskRunStatus === 'completed') {
    return {
      terminalLabel: 'Completed',
      ready: !errorSummary,
      errorSummary,
    };
  }

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

  // Fallback for unexpected settled shapes
  return {
    terminalLabel: statusLabel === 'Failed' ? 'Failed' : 'Idle',
    ready: !errorSummary && statusLabel !== 'Failed',
    errorSummary,
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

  while (true) {
    const summary = await deps.getTaskSummary(config, taskId);
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
      errorSummary: `Timed out after ${timeoutMs}ms waiting for task ${taskId}`,
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
