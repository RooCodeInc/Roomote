import { describe, expect, it, vi } from 'vitest';

import { readBoundedResponseBody } from '../bounded-response-body.js';

describe('readBoundedResponseBody', () => {
  it('returns an empty body', async () => {
    await expect(
      readBoundedResponseBody(new Response(null), 1, 'too large'),
    ).resolves.toEqual(new Uint8Array());
  });

  it('accepts a streamed body exactly at the limit', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2]));
          controller.enqueue(Uint8Array.from([3]));
          controller.close();
        },
      }),
    );

    await expect(
      readBoundedResponseBody(response, 3, 'too large'),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(response.body?.locked).toBe(false);
  });

  it('rejects an oversized declared length and cancels the body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '4' },
    });

    await expect(
      readBoundedResponseBody(response, 3, 'provider-specific error'),
    ).rejects.toThrow('provider-specific error');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('rejects a streamed body over the limit and releases its reader', async () => {
    const cancel = vi.fn();
    const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])];
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunks.shift()!);
        },
        cancel,
      }),
    );

    await expect(
      readBoundedResponseBody(response, 3, 'provider-specific error'),
    ).rejects.toThrow('provider-specific error');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('cancels and releases the reader when reading fails', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const response = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: vi.fn().mockRejectedValue(new Error('read failed')),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;

    await expect(
      readBoundedResponseBody(response, 3, 'provider-specific error'),
    ).rejects.toThrow('read failed');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
