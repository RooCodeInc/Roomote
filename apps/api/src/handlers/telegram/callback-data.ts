/**
 * Build/parse helpers for Telegram inline-keyboard `callback_data` strings.
 * Telegram limits callback_data to 64 bytes, so every action carries only a
 * short id (cloud job id, pending-route id) — heavy context is looked up
 * server-side from that id.
 */

const CANCEL_TASK_CALLBACK_PREFIX = 'cancel_task:';

export function buildTelegramCancelTaskCallbackData(
  cloudJobId: number,
): string {
  return `${CANCEL_TASK_CALLBACK_PREFIX}${cloudJobId}`;
}

export function parseCancelTaskCallbackData(data: string): number | null {
  if (!data.startsWith(CANCEL_TASK_CALLBACK_PREFIX)) {
    return null;
  }

  const cloudJobId = Number.parseInt(
    data.slice(CANCEL_TASK_CALLBACK_PREFIX.length),
    10,
  );

  return Number.isSafeInteger(cloudJobId) && cloudJobId > 0 ? cloudJobId : null;
}

const ROUTE_OK_CALLBACK_PREFIX = 'route_ok:';
const ROUTE_ALT_CALLBACK_PREFIX = 'route_alt:';
const ROUTE_PICK_CALLBACK_PREFIX = 'route_pick:';
const ROUTE_NO_CALLBACK_PREFIX = 'route_no:';

const PENDING_ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;

export type TelegramRouteCallbackAction =
  | { action: 'ok'; pendingRouteId: string }
  | { action: 'alt'; pendingRouteId: string }
  | { action: 'pick'; pendingRouteId: string; optionIndex: number }
  | { action: 'no'; pendingRouteId: string };

export function buildTelegramRouteOkCallbackData(
  pendingRouteId: string,
): string {
  return `${ROUTE_OK_CALLBACK_PREFIX}${pendingRouteId}`;
}

export function buildTelegramRouteAltCallbackData(
  pendingRouteId: string,
): string {
  return `${ROUTE_ALT_CALLBACK_PREFIX}${pendingRouteId}`;
}

export function buildTelegramRoutePickCallbackData(
  pendingRouteId: string,
  optionIndex: number,
): string {
  return `${ROUTE_PICK_CALLBACK_PREFIX}${pendingRouteId}:${optionIndex}`;
}

export function buildTelegramRouteNoCallbackData(
  pendingRouteId: string,
): string {
  return `${ROUTE_NO_CALLBACK_PREFIX}${pendingRouteId}`;
}

export function parseTelegramRouteCallbackData(
  data: string,
): TelegramRouteCallbackAction | null {
  if (data.startsWith(ROUTE_OK_CALLBACK_PREFIX)) {
    const pendingRouteId = data.slice(ROUTE_OK_CALLBACK_PREFIX.length);

    return PENDING_ROUTE_ID_PATTERN.test(pendingRouteId)
      ? { action: 'ok', pendingRouteId }
      : null;
  }

  if (data.startsWith(ROUTE_ALT_CALLBACK_PREFIX)) {
    const pendingRouteId = data.slice(ROUTE_ALT_CALLBACK_PREFIX.length);

    return PENDING_ROUTE_ID_PATTERN.test(pendingRouteId)
      ? { action: 'alt', pendingRouteId }
      : null;
  }

  if (data.startsWith(ROUTE_NO_CALLBACK_PREFIX)) {
    const pendingRouteId = data.slice(ROUTE_NO_CALLBACK_PREFIX.length);

    return PENDING_ROUTE_ID_PATTERN.test(pendingRouteId)
      ? { action: 'no', pendingRouteId }
      : null;
  }

  if (data.startsWith(ROUTE_PICK_CALLBACK_PREFIX)) {
    const rest = data.slice(ROUTE_PICK_CALLBACK_PREFIX.length);
    const separatorIndex = rest.lastIndexOf(':');

    if (separatorIndex <= 0) {
      return null;
    }

    const pendingRouteId = rest.slice(0, separatorIndex);
    const optionIndex = Number.parseInt(rest.slice(separatorIndex + 1), 10);

    return PENDING_ROUTE_ID_PATTERN.test(pendingRouteId) &&
      Number.isSafeInteger(optionIndex) &&
      optionIndex >= 0
      ? { action: 'pick', pendingRouteId, optionIndex }
      : null;
  }

  return null;
}
