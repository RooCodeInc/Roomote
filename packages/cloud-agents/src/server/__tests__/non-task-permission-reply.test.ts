import { describe, expect, it, vi } from 'vitest';

import { replyToPermissionAsk } from '../non-task-provider-usage';

describe('replyToPermissionAsk', () => {
  it('bounds an unresponsive native reply so the approval claim cannot block the experiment toggle', async () => {
    const client = {
      permission: {
        reply: vi.fn(
          (_parameters: unknown, options?: { signal?: AbortSignal }) =>
            new Promise<{ error?: unknown }>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                reject(options.signal?.reason),
              );
            }),
        ),
      },
    };
    await expect(
      replyToPermissionAsk(
        client as never,
        '/tmp/directory',
        'req-1',
        'once',
        undefined,
        10,
      ),
    ).rejects.toThrow();
    // The abort signal, not the server, ends the wait: the relay is bounded.
    expect(client.permission.reply).toHaveBeenCalledWith(
      expect.objectContaining({ requestID: 'req-1', reply: 'once' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('passes the reply through when the server answers promptly', async () => {
    const client = {
      permission: {
        reply: vi.fn(async () => ({})),
      },
    };
    const result = await replyToPermissionAsk(
      client as never,
      '/tmp/directory',
      'req-2',
      'reject',
      'no',
    );
    expect(result.error).toBeUndefined();
    expect(client.permission.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        requestID: 'req-2',
        reply: 'reject',
        message: 'no',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
