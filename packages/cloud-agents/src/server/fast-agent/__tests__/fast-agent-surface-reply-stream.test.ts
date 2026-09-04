import type { FastAgentReplyStream } from '../fast-agent-conversation';
import { createFastAgentSurfaceReplyStreamer } from '../fast-agent-surface-reply-stream';

function fakeStream() {
  const calls: string[] = [];
  const stream: FastAgentReplyStream = {
    append: vi.fn(async (text: string) => {
      calls.push(`append:${text}`);
    }),
    finish: vi.fn(async (reply) => {
      calls.push(`finish:${reply.message}`);
      return { messageId: 'ts-1' };
    }),
    abort: vi.fn(async () => {
      calls.push('abort');
    }),
  };
  return { stream, calls };
}

describe('createFastAgentSurfaceReplyStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a stream only for text still being written after the start delay, paces appends, and finishes with the reply', async () => {
    const { stream, calls } = fakeStream();
    const createStream = vi.fn(() => stream);
    const streamer = createFastAgentSurfaceReplyStreamer({
      createStream,
      startDelayMs: 100,
      intervalMs: 50,
    });

    streamer.update('Looking', true);
    await vi.advanceTimersByTimeAsync(99);
    expect(createStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(createStream).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['append:Looking']);

    streamer.update('Looking at', true);
    streamer.update('Looking at the logs', true);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual(['append:Looking', 'append: at the logs']);

    await expect(
      streamer.deliver({
        purpose: 'closeout',
        message: 'Looking at the logs.',
      }),
    ).resolves.toEqual({ messageId: 'ts-1' });
    expect(calls.at(-1)).toBe('finish:Looking at the logs.');
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('posts normally when the reply finished before the start delay or has no stream', async () => {
    const { stream } = fakeStream();
    const createStream = vi.fn(() => stream);
    const streamer = createFastAgentSurfaceReplyStreamer({
      createStream,
      startDelayMs: 100,
    });

    streamer.update('Done.', false);
    await vi.advanceTimersByTimeAsync(100);
    expect(createStream).not.toHaveBeenCalled();
    await expect(
      streamer.deliver({ purpose: 'closeout', message: 'Done.' }),
    ).resolves.toBeUndefined();

    const inert = createFastAgentSurfaceReplyStreamer({});
    inert.update('Still writing', true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(
      inert.deliver({ purpose: 'closeout', message: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('aborts an unfinished stream and survives surface failures', async () => {
    const { stream, calls } = fakeStream();
    vi.mocked(stream.append).mockRejectedValueOnce(new Error('rate limited'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const streamer = createFastAgentSurfaceReplyStreamer({
      createStream: () => stream,
      startDelayMs: 10,
      intervalMs: 10,
    });

    streamer.update('Half', true);
    await vi.advanceTimersByTimeAsync(10);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Surface reply stream step failed'),
    );
    await streamer.abort();
    expect(calls.at(-1)).toBe('abort');
    // A second abort or deliver without an active stream is a no-op.
    await streamer.abort();
    await expect(
      streamer.deliver({ purpose: 'closeout', message: 'x' }),
    ).resolves.toBeUndefined();
  });
});
