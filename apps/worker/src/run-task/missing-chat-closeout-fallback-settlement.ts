import type { HarnessLogger } from '../logging';
import type { RunTaskContext } from './types';
import { deliverMissingChatCloseoutFallback } from './missing-chat-closeout-fallback-delivery';

interface PendingMissingChatCloseoutFallback {
  runId: number;
  completionId: string;
  text: string | null;
  mcpTaskEnv?: Record<string, string>;
  logger: HarnessLogger;
}

interface MissingChatCloseoutFallbackState {
  pending: PendingMissingChatCloseoutFallback | null;
  settledCompletionIds: Set<string>;
  activeToolCallIds: Set<string>;
  deliveryTimer: ReturnType<typeof setTimeout> | null;
  deliveryWork: Set<Promise<void>>;
}

// OpenCode can emit a stale idle before trailing tool activity reaches Roomote.
// Give that activity a chance to cancel the otherwise-terminal fallback.
const MISSING_CHAT_CLOSEOUT_FALLBACK_GRACE_MS = 5_000;
const TERMINAL_TOOL_STATUSES = new Set([
  'canceled',
  'cancelled',
  'completed',
  'error',
  'failed',
]);

const stateByContext = new WeakMap<
  RunTaskContext,
  MissingChatCloseoutFallbackState
>();

function getState(context: RunTaskContext): MissingChatCloseoutFallbackState {
  const existing = stateByContext.get(context);
  if (existing) {
    return existing;
  }

  const state: MissingChatCloseoutFallbackState = {
    pending: null,
    settledCompletionIds: new Set(),
    activeToolCallIds: new Set(),
    deliveryTimer: null,
    deliveryWork: new Set(),
  };
  stateByContext.set(context, state);
  return state;
}

function clearDeliveryTimer(state: MissingChatCloseoutFallbackState): void {
  if (!state.deliveryTimer) {
    return;
  }

  clearTimeout(state.deliveryTimer);
  state.deliveryTimer = null;
}

function startDeliveryNowIfSettled(
  state: MissingChatCloseoutFallbackState,
  options?: { allowActiveTools?: boolean },
): Promise<void> | null {
  const pending = state.pending;
  if (
    !pending ||
    !state.settledCompletionIds.has(pending.completionId) ||
    (!options?.allowActiveTools && state.activeToolCallIds.size > 0)
  ) {
    return null;
  }

  state.pending = null;
  state.settledCompletionIds.delete(pending.completionId);
  const work = deliverMissingChatCloseoutFallback(pending);
  state.deliveryWork.add(work);
  void work.finally(() => {
    state.deliveryWork.delete(work);
  });
  return work;
}

function scheduleDeliveryIfSettled(
  state: MissingChatCloseoutFallbackState,
): void {
  const pending = state.pending;
  if (
    state.deliveryTimer ||
    !pending ||
    !state.settledCompletionIds.has(pending.completionId) ||
    state.activeToolCallIds.size > 0
  ) {
    return;
  }

  state.deliveryTimer = setTimeout(() => {
    state.deliveryTimer = null;
    startDeliveryNowIfSettled(state);
  }, MISSING_CHAT_CLOSEOUT_FALLBACK_GRACE_MS);
  state.deliveryTimer.unref?.();
}

export function recordMissingChatCloseoutFallback(
  context: RunTaskContext,
  pending: PendingMissingChatCloseoutFallback | null,
): void {
  const state = getState(context);
  clearDeliveryTimer(state);
  state.pending = pending;
  if (!pending) {
    state.settledCompletionIds.clear();
    return;
  }
  scheduleDeliveryIfSettled(state);
}

export function cancelPendingMissingChatCloseoutFallback(
  context: RunTaskContext,
): void {
  const state = stateByContext.get(context);
  if (!state?.pending) {
    return;
  }

  clearDeliveryTimer(state);
  state.pending = null;
  state.settledCompletionIds.clear();
}

export function recordMissingChatCloseoutToolActivity(
  context: RunTaskContext,
  input: { toolCallId: string; status: string | null },
): void {
  const state = getState(context);
  if (input.status && TERMINAL_TOOL_STATUSES.has(input.status)) {
    state.activeToolCallIds.delete(input.toolCallId);
    return;
  }

  state.activeToolCallIds.add(input.toolCallId);
}

export async function settleMissingChatCloseoutFallback(
  context: RunTaskContext,
  completionId: string,
): Promise<void> {
  const state = getState(context);
  state.settledCompletionIds.add(completionId);
  scheduleDeliveryIfSettled(state);
}

export async function waitForMissingChatCloseoutFallbackDelivery(
  context: RunTaskContext,
): Promise<void> {
  const state = stateByContext.get(context);
  if (!state) {
    return;
  }

  clearDeliveryTimer(state);
  await startDeliveryNowIfSettled(state, { allowActiveTools: true });

  while (state.deliveryWork.size > 0) {
    await Promise.allSettled([...state.deliveryWork]);
  }
}
