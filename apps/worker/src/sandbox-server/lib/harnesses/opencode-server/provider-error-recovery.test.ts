import { describe, expect, it } from 'vitest';

import {
  formatOpenCodeProviderErrorRetryNoticeText,
  getOpenCodeProviderErrorRecovery,
  isOpenCodeTerminalProviderError,
  resolveOpenCodeProviderErrorRetryDelayMs,
  summarizeOpenCodeProviderError,
} from './provider-error-recovery';

describe('getOpenCodeProviderErrorRecovery', () => {
  it('gives status-less policy codes the generic bounded retry budget', () => {
    // Only OpenCode's typed ContentFilterError selects the policy prompt;
    // provider policy code vocabulary is not classified.
    expect(
      getOpenCodeProviderErrorRecovery({
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
      }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 6 });
  });

  it('gives unknown provider errors a bounded retry budget', () => {
    expect(
      getOpenCodeProviderErrorRecovery({
        name: 'UnknownError',
        data: { message: 'Upstream connection closed unexpectedly.' },
      }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 6 });
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

  it('does not classify message wording as terminal without metadata', () => {
    expect(
      isOpenCodeTerminalProviderError({
        message: 'The provider returned an error: API key is invalid.',
      }),
    ).toBe(false);
    expect(
      getOpenCodeProviderErrorRecovery({
        message: 'The provider returned an error: API key is invalid.',
      }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 6 });
  });

  it('gives status-less billing codes the bounded retry budget', () => {
    const error = JSON.stringify({
      error: {
        code: 'insufficient_balance',
        message: 'There is not enough credit to run this request.',
      },
    });

    expect(isOpenCodeTerminalProviderError(error)).toBe(false);
    expect(getOpenCodeProviderErrorRecovery(error)).toMatchObject({
      kind: 'provider_error',
      maxRetries: 6,
    });
  });

  it('retries an otherwise-unclassified 402 response', () => {
    const error = JSON.stringify({
      error: {
        code: 402,
        message: 'Provider-defined payment response.',
      },
    });

    expect(isOpenCodeTerminalProviderError(error)).toBe(false);
    expect(getOpenCodeProviderErrorRecovery(error)).toMatchObject({
      kind: 'provider_error',
      maxRetries: 6,
    });
  });

  it.each([408, 429, 500, 503])(
    'keeps retryable status %d out of the terminal set',
    (statusCode) => {
      expect(isOpenCodeTerminalProviderError({ statusCode })).toBe(false);
      expect(getOpenCodeProviderErrorRecovery({ statusCode })).toMatchObject({
        kind: 'provider_error',
        maxRetries: 6,
      });
    },
  );

  it.each([
    {
      name: 'ContextOverflowError',
      data: { message: 'Input exceeds context window of this model' },
    },
    {
      cause: {
        name: 'ContextOverflowError',
        message: 'Input exceeds context window of this model',
      },
    },
    JSON.stringify({
      error: {
        name: 'ContextOverflowError',
        message: 'Input exceeds context window of this model',
      },
    }),
  ])('classifies structured context overflow names as terminal', (error) => {
    expect(isOpenCodeTerminalProviderError(error)).toBe(true);
    expect(getOpenCodeProviderErrorRecovery(error)).toBeNull();
  });

  it('classifies an explicit OpenRouter credit limit as terminal', () => {
    expect(
      isOpenCodeTerminalProviderError({
        name: 'APIError',
        data: {
          message:
            'This request requires more credits than your account balance.',
          statusCode: 402,
          isRetryable: true,
          responseBody: JSON.stringify({
            error: {
              metadata: { limit_source: 'openrouter_credits' },
            },
          }),
        },
      }),
    ).toBe(true);
  });

  it('retries message-only payment errors without structured metadata', () => {
    expect(
      isOpenCodeTerminalProviderError({ message: 'Payment required' }),
    ).toBe(false);
    expect(
      getOpenCodeProviderErrorRecovery({ message: 'Payment required' }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 6 });
  });

  it('does not classify policy-refusal prose without structured metadata', () => {
    expect(
      getOpenCodeProviderErrorRecovery({
        message: 'This content was flagged for possible cybersecurity risk.',
      }),
    ).toMatchObject({ kind: 'provider_error', maxRetries: 6 });
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
  it('uses a longer exponential backoff for transient provider overloads', () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((attemptNumber) =>
        resolveOpenCodeProviderErrorRetryDelayMs({ attemptNumber }),
      ),
    ).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

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
