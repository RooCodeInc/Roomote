import { describe, expect, it } from 'vitest';

import {
  buildTelegramCancelTaskCallbackData,
  parseCancelTaskCallbackData,
} from '../callback-data';

describe('telegram callback data', () => {
  it('round-trips cancel-task callback data', () => {
    expect(
      parseCancelTaskCallbackData(buildTelegramCancelTaskCallbackData(42)),
    ).toBe(42);
    expect(parseCancelTaskCallbackData('cancel_task:zero')).toBeNull();
    expect(parseCancelTaskCallbackData('route_ok:abc')).toBeNull();
  });
});
