import {
  type TaskStatusEvent,
  asFiniteNumber,
  asRecord,
  asString,
} from '@roomote/types';

const TASK_PHASES = new Set<TaskStatusEvent['phase']>([
  'idle',
  'waiting_for_prompt',
  'waiting_for_user_input',
  'running',
  'stopped',
  'shutting_down',
]);

/** Coerce an optional field: null/undefined input stays undefined, non-null
 *  input is validated via `coerce`, and a failed coercion signals an invalid
 *  payload by returning the `INVALID` sentinel. */
const INVALID = Symbol('invalid');

function coerceOptional<T>(
  raw: unknown,
  coerce: (v: unknown) => T | undefined,
): T | undefined | typeof INVALID {
  if (raw == null) {
    return undefined;
  }

  const result = coerce(raw);
  return result === undefined ? INVALID : result;
}

export function parseAcpTaskStatusFromOutputEvent(
  payloadValue: unknown,
): TaskStatusEvent | null {
  const payload = asRecord(payloadValue);
  const taskStatus = asRecord(payload?.taskStatus);

  if (!taskStatus) {
    return null;
  }

  const phase = asString(taskStatus.phase);

  if (!phase || !TASK_PHASES.has(phase as TaskStatusEvent['phase'])) {
    return null;
  }

  if (taskStatus.isConnected !== true && taskStatus.isConnected !== false) {
    return null;
  }

  const sleepRemainingMs = coerceOptional(
    taskStatus.sleepRemainingMs,
    asFiniteNumber,
  );

  const sessionId = coerceOptional(taskStatus.sessionId, asString);

  const lastErrorMessage = coerceOptional(
    taskStatus.lastErrorMessage,
    asString,
  );

  const taskStateEvent = coerceOptional(taskStatus.taskStateEvent, asString);

  if (
    sleepRemainingMs === INVALID ||
    sessionId === INVALID ||
    lastErrorMessage === INVALID ||
    taskStateEvent === INVALID
  ) {
    return null;
  }

  return {
    phase: phase as TaskStatusEvent['phase'],
    taskStateEvent: (taskStateEvent ??
      null) as TaskStatusEvent['taskStateEvent'],
    sessionId,
    isConnected: taskStatus.isConnected,
    sleepRemainingMs: sleepRemainingMs ?? null,
    lastErrorMessage,
  };
}
