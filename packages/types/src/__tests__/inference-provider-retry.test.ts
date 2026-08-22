import { describe, expect, it } from 'vitest';

import { resolveInferenceProviderRetryDelayMs } from '../inference-provider-retry';

describe('resolveInferenceProviderRetryDelayMs', () => {
  it('uses the task retry policy for provider and rate-limit failures', () => {
    expect(
      [1, 2, 3].map((attemptNumber) =>
        resolveInferenceProviderRetryDelayMs({
          attemptNumber,
          rateLimited: false,
        }),
      ),
    ).toEqual([1_000, 2_000, 4_000]);
    expect(
      [1, 2, 3].map((attemptNumber) =>
        resolveInferenceProviderRetryDelayMs({
          attemptNumber,
          rateLimited: true,
        }),
      ),
    ).toEqual([5_000, 10_000, 20_000]);
  });

  it('finds Retry-After in wrapped provider errors', () => {
    expect(
      resolveInferenceProviderRetryDelayMs({
        error: {
          providerError: {
            data: { responseHeaders: { 'retry-after': '12' } },
          },
        },
        attemptNumber: 1,
        rateLimited: true,
      }),
    ).toBe(12_000);
  });

  it('matches Retry-After headers case-insensitively', () => {
    expect(
      resolveInferenceProviderRetryDelayMs({
        error: { responseHeaders: { 'Retry-After': '7' } },
        attemptNumber: 1,
        rateLimited: true,
      }),
    ).toBe(7_000);
  });

  it('preserves configured sub-second rate-limit backoff', () => {
    expect(
      [1, 2].map((attemptNumber) =>
        resolveInferenceProviderRetryDelayMs({
          attemptNumber,
          rateLimited: true,
          baseDelayMs: 100,
        }),
      ),
    ).toEqual([100, 200]);
  });
});
