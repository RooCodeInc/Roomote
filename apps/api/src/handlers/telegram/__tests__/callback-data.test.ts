import { describe, expect, it } from 'vitest';

import {
  buildTelegramCancelTaskCallbackData,
  buildTelegramRouteAltCallbackData,
  buildTelegramRouteNoCallbackData,
  buildTelegramRouteOkCallbackData,
  buildTelegramRoutePickCallbackData,
  parseCancelTaskCallbackData,
  parseTelegramRouteCallbackData,
} from '../callback-data';

const PENDING_ROUTE_ID = 'aBc123XYZ_-9';

describe('telegram callback data', () => {
  it('round-trips cancel-task callback data', () => {
    expect(
      parseCancelTaskCallbackData(buildTelegramCancelTaskCallbackData(42)),
    ).toBe(42);
    expect(parseCancelTaskCallbackData('cancel_task:zero')).toBeNull();
    expect(parseCancelTaskCallbackData('route_ok:abc')).toBeNull();
  });

  it('round-trips route callback data', () => {
    expect(
      parseTelegramRouteCallbackData(
        buildTelegramRouteOkCallbackData(PENDING_ROUTE_ID),
      ),
    ).toEqual({ action: 'ok', pendingRouteId: PENDING_ROUTE_ID });
    expect(
      parseTelegramRouteCallbackData(
        buildTelegramRoutePickCallbackData(PENDING_ROUTE_ID, 3),
      ),
    ).toEqual({
      action: 'pick',
      pendingRouteId: PENDING_ROUTE_ID,
      optionIndex: 3,
    });
    expect(
      parseTelegramRouteCallbackData(
        buildTelegramRouteAltCallbackData(PENDING_ROUTE_ID),
      ),
    ).toEqual({ action: 'alt', pendingRouteId: PENDING_ROUTE_ID });
    expect(
      parseTelegramRouteCallbackData(
        buildTelegramRouteNoCallbackData(PENDING_ROUTE_ID),
      ),
    ).toEqual({ action: 'no', pendingRouteId: PENDING_ROUTE_ID });
  });

  it('stays within the Telegram 64-byte callback_data limit', () => {
    // Pending route ids are 12 base64url chars (9 random bytes).
    expect(
      Buffer.byteLength(
        buildTelegramRoutePickCallbackData(PENDING_ROUTE_ID, 99),
      ),
    ).toBeLessThanOrEqual(64);
  });

  it('rejects malformed route callback data', () => {
    expect(parseTelegramRouteCallbackData('route_ok:')).toBeNull();
    expect(parseTelegramRouteCallbackData('route_ok:has spaces')).toBeNull();
    expect(
      parseTelegramRouteCallbackData('route_pick:abc123XYZ_-9'),
    ).toBeNull();
    expect(
      parseTelegramRouteCallbackData('route_pick:abc123XYZ_-9:-1'),
    ).toBeNull();
    expect(
      parseTelegramRouteCallbackData('route_pick:abc123XYZ_-9:one'),
    ).toBeNull();
    expect(parseTelegramRouteCallbackData('cancel_task:42')).toBeNull();
    expect(parseTelegramRouteCallbackData('')).toBeNull();
  });
});
