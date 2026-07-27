import { describe, expect, it } from 'vitest';

import {
  formatOpenCodeProviderErrorRetryNoticeText,
  getOpenCodeProviderErrorRecovery,
  isOpenCodeTerminalProviderError,
  resolveOpenCodeProviderErrorRetryDelayMs,
  summarizeOpenCodeProviderError,
} from './provider-error-recovery';

describe('getOpenCodeProviderErrorRecovery', () => {
  it('detects an UnknownError-wrapped cyber policy refusal', () => {
    const recovery = getOpenCodeProviderErrorRecovery({
      name: 'UnknownError',
      data: {
        message: JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request',
            code: 'cyber_policy',
            message:
              'This content was flagged for possible cybersecurity risk.',
          },
        }),
      },
    });

    expect(recovery).toMatchObject({ kind: 'policy_refusal', maxRetries: 2 });
    expect(recovery?.promptText).toContain('Continue the legitimate task');
    expect(recovery?.promptText).toContain(
      'Do not attempt to bypass the policy',
    );
  });

  it('treats unknown provider errors as recoverable once', () => {
    expect(
      getOpenCodeProviderErrorRecovery({
        name: 'UnknownError',
        data: { message: 'Upstream connection closed unexpectedly.' },
      }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 3 });
  });

  it('classifies native ContentFilterError payloads as policy refusals', () => {
    const recovery = getOpenCodeProviderErrorRecovery({
      name: 'ContentFilterError',
      data: {
        message: "The response was blocked by the provider's content filter",
      },
    });

    expect(recovery).toMatchObject({ kind: 'policy_refusal', maxRetries: 2 });
    expect(recovery?.promptText).toContain('Continue the legitimate task');
  });

  it('does not retry explicit non-retryable configuration errors', () => {
    expect(
      getOpenCodeProviderErrorRecovery({
        name: 'APIError',
        data: {
          message: 'The selected model is not available in your region.',
          statusCode: 403,
          isRetryable: false,
        },
      }),
    ).toBeNull();
  });

  it('classifies API key is invalid wording as terminal without metadata', () => {
    expect(
      isOpenCodeTerminalProviderError({
        message: 'The provider returned an error: API key is invalid.',
      }),
    ).toBe(true);
    expect(
      getOpenCodeProviderErrorRecovery({
        message: 'The provider returned an error: API key is invalid.',
      }),
    ).toBeNull();
  });

  it.each([
    'Your account org-redacted is suspended due to insufficient balance, please recharge your account or check your plan and billing details',
    JSON.stringify({
      error: {
        code: 'insufficient_balance',
        message: 'There is not enough credit to run this request.',
      },
    }),
  ])(
    'classifies provider billing and suspension errors as terminal',
    (error) => {
      expect(isOpenCodeTerminalProviderError(error)).toBe(true);
      expect(getOpenCodeProviderErrorRecovery(error)).toBeNull();
    },
  );

  it('classifies payment-required responses as terminal', () => {
    expect(
      isOpenCodeTerminalProviderError({
        name: 'APIError',
        data: {
          message: 'Payment required',
          statusCode: 402,
          isRetryable: true,
        },
      }),
    ).toBe(true);
  });

  it('classifies message-only payment-required retry status as terminal', () => {
    // handleSessionStatus only has the retry status message, not statusCode/code.
    expect(
      isOpenCodeTerminalProviderError({ message: 'Payment required' }),
    ).toBe(true);
    expect(
      getOpenCodeProviderErrorRecovery({ message: 'Payment required' }),
    ).toBeNull();
  });
});

describe('summarizeOpenCodeProviderError', () => {
  it('prefers nested provider messages over raw JSON wrappers', () => {
    expect(
      summarizeOpenCodeProviderError({
        name: 'UnknownError',
        data: {
          message: JSON.stringify({
            type: 'error',
            error: {
              code: 'cyber_policy',
              message:
                'This content was flagged for possible cybersecurity risk.',
            },
          }),
        },
      }),
    ).toBe('This content was flagged for possible cybersecurity risk.');
  });
});

describe('formatOpenCodeProviderErrorRetryNoticeText', () => {
  it('includes the error summary and retry delay', () => {
    expect(
      formatOpenCodeProviderErrorRetryNoticeText({
        kind: 'provider_error',
        attemptNumber: 1,
        maxAttempts: 3,
        errorSummary: 'Upstream connection closed unexpectedly.',
        delayMs: 1_000,
      }),
    ).toBe(
      'Provider error: Upstream connection closed unexpectedly.\n\nRetrying in 1s (attempt 1/3).',
    );
  });
});

describe('resolveOpenCodeProviderErrorRetryDelayMs', () => {
  it('waits at least one second and exponentially backs off', () => {
    expect(
      [1, 2, 3].map((attemptNumber) =>
        resolveOpenCodeProviderErrorRetryDelayMs({
          attemptNumber,
          baseDelayMs: 100,
          maxDelayMs: 10_000,
        }),
      ),
    ).toEqual([1_000, 2_000, 4_000]);
  });
});
