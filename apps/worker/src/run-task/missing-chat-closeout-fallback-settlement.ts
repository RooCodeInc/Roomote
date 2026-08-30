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
  deliveryWork: Set<Promise<void>>;
}

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
    deliveryWork: new Set(),
  };
  stateByContext.set(context, state);
  return state;
}

function startDeliveryIfSettled(
  state: MissingChatCloseoutFallbackState,
): Promise<void> | null {
  const pending = state.pending;
  if (!pending || !state.settledCompletionIds.has(pending.completionId)) {
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

export function recordMissingChatCloseoutFallback(
  context: RunTaskContext,
  pending: PendingMissingChatCloseoutFallback | null,
): void {
  const state = getState(context);
  state.pending = pending;
  void startDeliveryIfSettled(state);
}

export async function settleMissingChatCloseoutFallback(
  context: RunTaskContext,
  completionId: string,
): Promise<void> {
  const state = getState(context);
  state.settledCompletionIds.add(completionId);
  await startDeliveryIfSettled(state);
}

export async function waitForMissingChatCloseoutFallbackDelivery(
  context: RunTaskContext,
): Promise<void> {
  const state = stateByContext.get(context);
  if (!state) {
    return;
  }

  while (state.deliveryWork.size > 0) {
    await Promise.allSettled([...state.deliveryWork]);
  }
}
