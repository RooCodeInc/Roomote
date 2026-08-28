import { describe, expect, it, vi } from 'vitest';

import { waitForOpenCodeServer } from './readiness';

describe('waitForOpenCodeServer', () => {
  it('retries until the health probe succeeds', async () => {
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce();

    await waitForOpenCodeServer({
      baseUrl: 'http://127.0.0.1:4321',
      timeoutMs: 100,
      retryIntervalMs: 1,
      probe,
    });

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('includes the target and last probe failure in timeout errors', async () => {
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      waitForOpenCodeServer({
        baseUrl: 'http://127.0.0.1:4321',
        timeoutMs: 10,
        retryIntervalMs: 1,
        probe,
      }),
    ).rejects.toThrow(
      'Timed out waiting for OpenCode server readiness at http://127.0.0.1:4321. Last probe error: connect ECONNREFUSED',
    );
  });

  it('retains the timeout diagnostic when the deadline elapses between checks', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(9)
      .mockReturnValue(11);
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      waitForOpenCodeServer({
        baseUrl: 'http://127.0.0.1:4321',
        timeoutMs: 10,
        retryIntervalMs: 1,
        probe,
      }),
    ).rejects.toThrow(
      'Timed out waiting for OpenCode server readiness at http://127.0.0.1:4321. Last probe error: connect ECONNREFUSED',
    );
    expect(probe).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('stops retrying when the readiness wait is aborted', async () => {
    const controller = new AbortController();
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    const readiness = waitForOpenCodeServer({
      baseUrl: 'http://127.0.0.1:4321',
      timeoutMs: 30_000,
      retryIntervalMs: 30_000,
      probe,
      signal: controller.signal,
    });

    controller.abort(new Error('OpenCode subprocess exited.'));

    await expect(readiness).rejects.toThrow('OpenCode subprocess exited.');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
