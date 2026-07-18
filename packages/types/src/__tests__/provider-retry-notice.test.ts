import { describe, expect, it } from 'vitest';

import {
  PROVIDER_RETRY_NOTICE_PAYLOAD_KEY,
  getProviderRetryNoticeFromMessageData,
  parseProviderRetryNotice,
} from '../provider-retry-notice';

describe('parseProviderRetryNotice', () => {
  it('accepts a complete provider retry notice payload', () => {
    expect(
      parseProviderRetryNotice({
        kind: 'rate_limit',
        attemptNumber: 2,
        maxAttempts: 3,
        delayMs: 5_000,
        retryAtMs: 1_700_000_000_000,
        errorSummary: 'Too many requests',
      }),
    ).toEqual({
      kind: 'rate_limit',
      attemptNumber: 2,
      maxAttempts: 3,
      delayMs: 5_000,
      retryAtMs: 1_700_000_000_000,
      errorSummary: 'Too many requests',
    });
  });

  it('rejects incomplete payloads', () => {
    expect(
      parseProviderRetryNotice({
        kind: 'provider_error',
        attemptNumber: 1,
      }),
    ).toBeNull();
  });
});

describe('getProviderRetryNoticeFromMessageData', () => {
  it('reads the structured notice from message data', () => {
    expect(
      getProviderRetryNoticeFromMessageData({
        [PROVIDER_RETRY_NOTICE_PAYLOAD_KEY]: {
          kind: 'provider_error',
          attemptNumber: 1,
          maxAttempts: 1,
          errorSummary: 'Upstream reset',
        },
      }),
    ).toEqual({
      kind: 'provider_error',
      attemptNumber: 1,
      maxAttempts: 1,
      errorSummary: 'Upstream reset',
    });
  });
});
