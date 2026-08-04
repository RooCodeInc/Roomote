// pnpm --filter @roomote/slack test src/__tests__/post-message-delivery.test.ts

import {
  isNonRetryableSlackPostErrorCode,
  SlackPostDeliveryError,
} from '../post-message-delivery';

describe('isNonRetryableSlackPostErrorCode', () => {
  it('classifies channel and credential errors as non-retryable', () => {
    expect(isNonRetryableSlackPostErrorCode('not_in_channel')).toBe(true);
    expect(isNonRetryableSlackPostErrorCode('channel_not_found')).toBe(true);
    expect(isNonRetryableSlackPostErrorCode('is_archived')).toBe(true);
    expect(isNonRetryableSlackPostErrorCode('invalid_auth')).toBe(true);
    expect(isNonRetryableSlackPostErrorCode('token_revoked')).toBe(true);
  });

  it('keeps content-dependent and unknown errors retryable', () => {
    expect(isNonRetryableSlackPostErrorCode('msg_too_long')).toBe(false);
    expect(isNonRetryableSlackPostErrorCode('invalid_blocks')).toBe(false);
    expect(isNonRetryableSlackPostErrorCode('rate_limited')).toBe(false);
    expect(isNonRetryableSlackPostErrorCode('unknown_error')).toBe(false);
    expect(isNonRetryableSlackPostErrorCode(undefined)).toBe(false);
  });
});

describe('SlackPostDeliveryError', () => {
  it('is non-retryable for permanent Slack error codes', () => {
    const error = new SlackPostDeliveryError({
      slackErrorCode: 'not_in_channel',
    });

    expect(error.message).toBe('Slack chat.postMessage failed: not_in_channel');
    expect(error.slackErrorCode).toBe('not_in_channel');
    expect(error.retryable).toBe(false);
  });

  it('is retryable for transport failures', () => {
    const error = new SlackPostDeliveryError({ transportError: true });

    expect(error.message).toBe(
      'Slack chat.postMessage failed: transport error',
    );
    expect(error.transportError).toBe(true);
    expect(error.retryable).toBe(true);
  });

  it('is retryable for content-dependent Slack error codes', () => {
    const error = new SlackPostDeliveryError({
      slackErrorCode: 'msg_too_long',
    });

    expect(error.retryable).toBe(true);
  });
});
