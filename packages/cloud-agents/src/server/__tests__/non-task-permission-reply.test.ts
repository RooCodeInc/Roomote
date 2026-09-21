import { describe, expect, it, vi } from 'vitest';

import { replyToPermissionAsk } from '../non-task-provider-usage';

describe('replyToPermissionAsk', () => {
  function hangingClient(pendingIds: string[]) {
    return {
      permission: {
        reply: vi.fn(
          (_parameters: unknown, options?: { signal?: AbortSignal }) =>
            new Promise<{ error?: unknown }>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                reject(options.signal?.reason),
              );
            }),
        ),
        list: vi.fn(async () => ({
          data: pendingIds.map((id) => ({ id })),
        })),
      },
    };
  }

  it('treats a timed-out reply as accepted when the request is no longer pending', async () => {
    // OpenCode accepted the reply but the response was lost: the claim must
    // still record the relay instead of rolling back over an executing call.
    const client = hangingClient([]);
    const result = await replyToPermissionAsk(
      client as never,
      '/tmp/directory',
      'req-1',
      'once',
      undefined,
      10,
    );
    expect(result.error).toBeUndefined();
    expect(client.permission.list).toHaveBeenCalledWith(
      { directory: '/tmp/directory' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fails the relay when the request is still pending after the timeout', async () => {
    // The reply genuinely never landed: bounded failure, claim rolls back.
    const client = hangingClient(['req-1']);
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
