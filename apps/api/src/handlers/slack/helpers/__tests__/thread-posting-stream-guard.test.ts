vi.mock('../../../../logging.js', () => ({
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { guardReplyStreamBySourceMessage } from '../thread-posting';

function fakeStream() {
  return {
    append: vi.fn(async () => {}),
    finish: vi.fn(async () => ({ messageId: 'reply-ts' })),
    abort: vi.fn(async () => {}),
  };
}

const params = { channel: 'C1', threadTs: '100.1', sourceMessageTs: '100.2' };

describe('guardReplyStreamBySourceMessage', () => {
  it('streams and finishes while the source message is still in the thread', async () => {
    const inner = fakeStream();
    const slack = { hasMessageInThread: vi.fn(async () => true) };
    const guarded = guardReplyStreamBySourceMessage(inner, {
      slack,
      ...params,
    });

    await guarded.append('Hel');
    await guarded.append('lo');
    expect(inner.append).toHaveBeenCalledTimes(2);
    // The open-time check is made once; the finish re-checks.
    expect(slack.hasMessageInThread).toHaveBeenCalledTimes(1);
    await expect(
      guarded.finish({ purpose: 'closeout', message: 'Hello' }),
    ).resolves.toEqual({ messageId: 'reply-ts' });
    expect(slack.hasMessageInThread).toHaveBeenCalledTimes(2);
  });

  it('never opens a stream for a deleted source and yields no delivery', async () => {
    const inner = fakeStream();
    const slack = { hasMessageInThread: vi.fn(async () => false) };
    const guarded = guardReplyStreamBySourceMessage(inner, {
      slack,
      ...params,
    });

    await guarded.append('Hello');
    expect(inner.append).not.toHaveBeenCalled();
    await expect(
      guarded.finish({ purpose: 'closeout', message: 'Hello' }),
    ).resolves.toBeUndefined();
    expect(inner.finish).not.toHaveBeenCalled();
  });

  it('ends a stream whose source was deleted mid-way and treats an unknown state as present', async () => {
    const inner = fakeStream();
    const slack = {
      hasMessageInThread: vi
        .fn<() => Promise<boolean | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(false),
    };
    const guarded = guardReplyStreamBySourceMessage(inner, {
      slack,
      ...params,
    });

    await guarded.append('Hello');
    expect(inner.append).toHaveBeenCalledTimes(1);
    await expect(
      guarded.finish({ purpose: 'closeout', message: 'Hello' }),
    ).resolves.toBeUndefined();
    expect(inner.abort).toHaveBeenCalledTimes(1);
    expect(inner.finish).not.toHaveBeenCalled();
  });
});
