/**
 * Build/parse helpers for Telegram inline-keyboard `callback_data` strings.
 * Telegram limits callback_data to 64 bytes, so every action carries only a
 * short id (task run id, pending-route id) — heavy context is looked up
 * server-side from that id.
 */

const CANCEL_TASK_CALLBACK_PREFIX = 'cancel_task:';

export function buildTelegramCancelTaskCallbackData(runId: number): string {
  return `${CANCEL_TASK_CALLBACK_PREFIX}${runId}`;
}

export function parseCancelTaskCallbackData(data: string): number | null {
  if (!data.startsWith(CANCEL_TASK_CALLBACK_PREFIX)) {
    return null;
  }

  const runId = Number.parseInt(
    data.slice(CANCEL_TASK_CALLBACK_PREFIX.length),
    10,
  );

  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}
