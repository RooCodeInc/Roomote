import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODE_RATE_LIMIT_BASE_DELAY_MS,
  formatOpenCodeRateLimitRetryNoticeText,
  isOpenCodeProviderRateLimitError,
  resolveOpenCodeRateLimitRetryDelayMs,
} from './provider-rate-limit';

describe('isOpenCodeProviderRateLimitError', () => {
  it('detects OpenRouter UnknownError JSON with rate_limit_exceeded', () => {
    expect(
      isOpenCodeProviderRateLimitError({
        name: 'UnknownError',
        data: {
          message: JSON.stringify({
            code: 429,
            message: 'Provider returned error',
            metadata: { error_type: 'rate_limit_exceeded' },
          }),
        },
      }),
    ).toBe(true);
  });

  it('detects APIError with statusCode 429', () => {
    expect(
      isOpenCodeProviderRateLimitError({
        name: 'APIError',
        data: {
          message: 'Too many requests',
          statusCode: 429,
          isRetryable: true,
        },
      }),
    ).toBe(true);
  });

  it('requires an HTTP 429; identifier strings and wording do not count', () => {
    expect(
      isOpenCodeProviderRateLimitError({ code: 'rate_limit_exceeded' }),
    ).toBe(false);
    expect(
      isOpenCodeProviderRateLimitError({
        metadata: { error_type: 'too_many_requests' },
      }),
    ).toBe(false);
    expect(
      isOpenCodeProviderRateLimitError({ message: 'Too many requests' }),
    ).toBe(false);
  });

  it('does not retry an explicitly non-retryable 429', () => {
    expect(
      isOpenCodeProviderRateLimitError({
        statusCode: 429,
        isRetryable: false,
      }),
    ).toBe(false);
  });

  it('rejects non-rate-limit provider errors', () => {
    expect(
      isOpenCodeProviderRateLimitError({
        name: 'APIError',
        data: {
          message: 'model not available in your region',
          statusCode: 403,
          isRetryable: false,
        },
      }),
    ).toBe(false);
  });
});

describe('resolveOpenCodeRateLimitRetryDelayMs', () => {
  it('uses exponential backoff when no Retry-After header is present', () => {
    expect(
      resolveOpenCodeRateLimitRetryDelayMs({
        error: { name: 'UnknownError' },
        attemptNumber: 1,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
      }),
    ).toBe(5_000);
    expect(
      resolveOpenCodeRateLimitRetryDelayMs({
        error: { name: 'UnknownError' },
        attemptNumber: 3,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
      }),
    ).toBe(20_000);
  });

  it('honors retry-after seconds when present', () => {
    expect(
      resolveOpenCodeRateLimitRetryDelayMs({
        error: {
          name: 'APIError',
          data: {
            statusCode: 429,
            responseHeaders: { 'retry-after': '12' },
          },
        },
        attemptNumber: 1,
        baseDelayMs: DEFAULT_OPENCODE_RATE_LIMIT_BASE_DELAY_MS,
        maxDelayMs: 60_000,
      }),
    ).toBe(12_000);
  });
});

describe('formatOpenCodeRateLimitRetryNoticeText', () => {
  it('includes the error, attempt, and delay in the user-facing notice', () => {
    expect(
      formatOpenCodeRateLimitRetryNoticeText({
        attemptNumber: 2,
        maxAttempts: 3,
        delayMs: 10_000,
        errorSummary: 'Too many requests',
      }),
    ).toBe(
      'Provider rate limit: Too many requests\n\nRetrying in 10s (attempt 2/3).',
    );
  });
});
