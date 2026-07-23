import {
  buildPrReviewActionCallbackData,
  parsePrReviewActionCallbackData,
} from '../pr-review-action';

describe('pr review action callback data', () => {
  it('round-trips every choice through provider callback data', () => {
    const nonce = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    for (const choice of ['yes', 'auto', 'dismiss'] as const) {
      const data = buildPrReviewActionCallbackData(choice, nonce);

      expect(parsePrReviewActionCallbackData(data)).toEqual({ choice, nonce });
    }
  });

  it('stays within the Telegram 64-byte callback_data limit for UUID nonces', () => {
    const data = buildPrReviewActionCallbackData(
      'dismiss',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );

    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  it('rejects foreign and malformed callback data', () => {
    expect(parsePrReviewActionCallbackData(undefined)).toBeNull();
    expect(parsePrReviewActionCallbackData('route_ok:abc')).toBeNull();
    expect(parsePrReviewActionCallbackData('prr:x:nonce-1')).toBeNull();
    expect(parsePrReviewActionCallbackData('prr:y:')).toBeNull();
    expect(
      parsePrReviewActionCallbackData('prr:y:$(rm -rf /)involving-bad-chars'),
    ).toBeNull();
  });
});
