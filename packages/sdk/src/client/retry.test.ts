import { retryAsync } from './retry';

describe('retryAsync', () => {
  it('retries retryable errors until a later success', async () => {
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('ok');

    await expect(
      retryAsync(execute, {
        maxAttempts: 2,
        getDelayMs: () => 0,
        shouldRetry: ({ error }) => Boolean(error),
      }),
    ).resolves.toBe('ok');

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retries retryable results until a later success', async () => {
    const execute = vi
      .fn<() => Promise<{ retry: boolean }>>()
      .mockResolvedValueOnce({ retry: true })
      .mockResolvedValueOnce({ retry: false });

    const result = await retryAsync(execute, {
      maxAttempts: 2,
      getDelayMs: () => 0,
      shouldRetry: ({ result }) => result?.retry === true,
    });

    expect(result).toEqual({ retry: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not retry abort errors', async () => {
    const abortError = new DOMException(
      'The operation was aborted',
      'AbortError',
    );
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(abortError);

    await expect(
      retryAsync(execute, {
        maxAttempts: 3,
        getDelayMs: () => 0,
        shouldRetry: () => true,
      }),
    ).rejects.toBe(abortError);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('throws immediately for non-retryable errors', async () => {
    const error = new Error('permanent failure');
    const execute = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(
      retryAsync(execute, {
        maxAttempts: 3,
        getDelayMs: () => 0,
        shouldRetry: ({ error }) => error instanceof TypeError,
      }),
    ).rejects.toBe(error);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('throws when maxAttempts is invalid', async () => {
    await expect(
      retryAsync(async () => 'ok', {
        maxAttempts: 0,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('maxAttempts must be at least 1');
  });
});
