import { describe, expect, it } from 'vitest';

import {
  PROVIDER_RETRY_NOTICE_PAYLOAD_KEY,
  TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY,
  getProviderRetryNoticeFromMessageData,
  getTerminalProviderErrorFromMessageData,
  parseProviderRetryNotice,
  parseTerminalProviderError,
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
        providerId: 'openrouter',
        modelId: 'openrouter/anthropic/claude-sonnet-4',
      }),
    ).toEqual({
      kind: 'rate_limit',
      attemptNumber: 2,
      maxAttempts: 3,
      delayMs: 5_000,
      retryAtMs: 1_700_000_000_000,
      errorSummary: 'Too many requests',
      providerId: 'openrouter',
      modelId: 'openrouter/anthropic/claude-sonnet-4',
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

describe('terminal provider errors', () => {
  it('reads a structured terminal provider error from message data', () => {
    expect(
      getTerminalProviderErrorFromMessageData({
        [TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY]: {
          errorSummary: 'The provider returned an error: API key is invalid.',
        },
      }),
    ).toEqual({
      errorSummary: 'The provider returned an error: API key is invalid.',
    });
  });

  it('rejects terminal errors without a usable summary', () => {
    expect(parseTerminalProviderError({ errorSummary: ' ' })).toBeNull();
  });
});
