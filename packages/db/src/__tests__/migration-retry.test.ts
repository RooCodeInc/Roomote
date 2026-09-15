import { describe, expect, it, vi } from 'vitest';

import {
  isRetryableConnectionError,
  retryOnConnectionError,
} from '../migration-retry';

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`boom ${code}`), { code });
}

describe('isRetryableConnectionError', () => {
  it('matches postgres.js connection error codes', () => {
    expect(isRetryableConnectionError(errorWithCode('CONNECTION_CLOSED'))).toBe(
      true,
    );
    expect(isRetryableConnectionError(errorWithCode('ECONNRESET'))).toBe(true);
    expect(isRetryableConnectionError(errorWithCode('57P01'))).toBe(true);
  });

  it('matches the null-socket write TypeError from porsager/postgres#1208', () => {
    expect(
      isRetryableConnectionError(
        new TypeError("Cannot read properties of null (reading 'write')"),
      ),
    ).toBe(true);
    expect(
      isRetryableConnectionError(
        new TypeError("null is not an object (evaluating 'socket.write')"),
      ),
    ).toBe(true);
  });

  it('does not match SQL errors or unrelated failures', () => {
    expect(isRetryableConnectionError(errorWithCode('42P07'))).toBe(false);
    expect(
      isRetryableConnectionError(new TypeError('x is not a function')),
    ).toBe(false);
    expect(isRetryableConnectionError(new Error('syntax error'))).toBe(false);
    expect(isRetryableConnectionError(null)).toBe(false);
    expect(isRetryableConnectionError('CONNECTION_CLOSED')).toBe(false);
  });
});

describe('retryOnConnectionError', () => {
  const sleep = vi.fn(async () => undefined);

  it('retries connection errors with a growing delay and returns the eventual result', async () => {
    sleep.mockClear();
    const onRetry = vi.fn();
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(errorWithCode('CONNECTION_CLOSED'))
      .mockRejectedValueOnce(
        new TypeError("Cannot read properties of null (reading 'write')"),
      )
      .mockResolvedValueOnce('done');

    await expect(
      retryOnConnectionError(attempt, {
        maxAttempts: 3,
        delayMs: 100,
        sleep,
        onRetry,
      }),
    ).resolves.toBe('done');

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(expect.any(TypeError), 2, 3);
  });

  it('rethrows the last connection error once attempts are exhausted', async () => {
    sleep.mockClear();
    const error = errorWithCode('ECONNRESET');
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      retryOnConnectionError(attempt, { maxAttempts: 2, delayMs: 10, sleep }),
    ).rejects.toBe(error);

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-connection errors', async () => {
    sleep.mockClear();
    const error = errorWithCode('42601');
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      retryOnConnectionError(attempt, { maxAttempts: 3, delayMs: 10, sleep }),
    ).rejects.toBe(error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
