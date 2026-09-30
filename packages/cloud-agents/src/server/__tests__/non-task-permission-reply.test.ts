import { describe, expect, it, vi } from 'vitest';

import {
  PermissionReplyFailedError,
  replyToPermissionAsk,
} from '../non-task-provider-usage';

function clientWith(reply: ReturnType<typeof vi.fn>) {
  return { permission: { reply } } as unknown as Parameters<
    typeof replyToPermissionAsk
  >[0];
}

describe('replyToPermissionAsk', () => {
  it('sends the reply with an abort signal so it can never wait forever', async () => {
    const reply = vi.fn(async () => ({}));
    await replyToPermissionAsk(clientWith(reply), '/dir', 'req-1', 'once');

    expect(reply).toHaveBeenCalledTimes(1);
    const [parameters, options] = reply.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { signal?: AbortSignal },
    ];
    expect(parameters).toEqual({
      requestID: 'req-1',
      directory: '/dir',
      reply: 'once',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts an unresponsive reply at the timeout and retries once', async () => {
    const reply = vi.fn(
      (_parameters: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<{ error?: unknown }>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    await expect(
      replyToPermissionAsk(
        clientWith(reply),
        '/dir',
        'req-1',
        'reject',
        'not run',
        20,
      ),
    ).rejects.toThrow('aborted');
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('recovers when only the first attempt is dropped', async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(new Error('dropped'))
      .mockResolvedValueOnce({});
    await expect(
      replyToPermissionAsk(clientWith(reply), '/dir', 'req-1', 'once'),
    ).resolves.toEqual({});
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('treats a returned SDK error as a failed attempt, retries, then throws', async () => {
    // The SDK resolves with `{ error }` instead of rejecting.
    const reply = vi.fn(async () => ({ error: { name: 'NotFound' } }));
    await expect(
      replyToPermissionAsk(clientWith(reply), '/dir', 'req-1', 'once'),
    ).rejects.toBeInstanceOf(PermissionReplyFailedError);
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('recovers when only the first attempt returns an SDK error', async () => {
    const reply = vi
      .fn()
      .mockResolvedValueOnce({ error: { name: 'Transient' } })
      .mockResolvedValueOnce({});
    await expect(
      replyToPermissionAsk(clientWith(reply), '/dir', 'req-1', 'once'),
    ).resolves.toEqual({});
    expect(reply).toHaveBeenCalledTimes(2);
  });
});
