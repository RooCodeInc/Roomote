import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  current: 'old',
  resolve: vi.fn(),
  forget: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => mocks.store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && mocks.store.has(key)) return null;
      mocks.store.set(key, value);
      return 'OK';
    },
    eval: async (
      _script: string,
      _count: number,
      key: string,
      owner: string,
    ) => {
      if (mocks.store.get(key) !== owner) return 0;
      mocks.store.delete(key);
      return 1;
    },
  }),
}));
vi.mock('@roomote/communication', () => ({
  resolveCurrentThreadFooterText: mocks.resolve,
  forgetThreadFooterRefresh: mocks.forget,
  scheduleThreadFooterRefresh: mocks.schedule,
}));
vi.mock('../thread-footer', () => ({
  buildSlackThreadFooterText: vi.fn(),
  resolveSlackThreadFooterContext: vi.fn(),
}));
vi.mock('../slack-messages', () => ({
  getSlackThreadReplyFooterMessageTs: async () => mocks.current || null,
  setSlackThreadReplyFooterMessageTs: async (
    _channel: string,
    _thread: string,
    ts: string,
  ) => {
    mocks.current = ts;
  },
}));

import {
  buildSlackThreadReplyFooterBlock,
  postSlackThreadMessageWithFooterText,
  refreshSlackThreadReplyFooter,
  updateSlackThreadMessageWithFooterText,
} from '../thread-reply-footer-ops';

describe('Slack lifecycle footer refresh', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.current = 'old';
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue('running');
  });
  const body = { type: 'markdown', text: 'Narrative' };
  const image = {
    type: 'image',
    image_url: 'https://image',
    alt_text: 'proof',
  };
  const slack = () => ({
    getMessageBlocks: vi.fn(
      async (): Promise<unknown[] | null> => [
        body,
        image,
        buildSlackThreadReplyFooterBlock({ footerText: 'idle' }),
      ],
    ),
    updateMessage: vi.fn(async () => true),
    postMessage: vi.fn(async () => 'new'),
  });

  it('edits just the current footer block, preserving body, images and fallback text', async () => {
    const provider = slack();
    await refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    expect(provider.getMessageBlocks).toHaveBeenCalledWith({
      channel: 'C',
      threadTs: 'T',
      messageTs: 'old',
      throwOnUnavailable: true,
    });
    expect(provider.updateMessage).toHaveBeenCalledWith({
      channel: 'C',
      ts: 'old',
      message: {
        blocks: [
          body,
          image,
          buildSlackThreadReplyFooterBlock({ footerText: 'running' }),
        ],
      },
    });
    expect(provider.postMessage).not.toHaveBeenCalled();
  });

  it.each(['post', 'update'])(
    'a late %s preserves a competing pointer and strips only its own footer',
    async (operation) => {
      const provider = slack();
      const competitor = slack();
      const takeOver = async () => {
        mocks.store.delete('slack:thread_reply_footer_lock:C:T');
        await postSlackThreadMessageWithFooterText({
          slack: competitor,
          channel: 'C',
          threadTs: 'T',
          text: 'B',
          bodyBlocks: [body],
          footerText: 'running',
        });
      };
      const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
      const params = {
        slack: provider,
        channel: 'C',
        threadTs: 'T',
        text: 'A',
        bodyBlocks: [body, image],
        footerText: 'running',
      };
      if (operation === 'post') {
        provider.postMessage.mockImplementationOnce(async () => {
          await takeOver();
          return 'orphan';
        });
        await postSlackThreadMessageWithFooterText(params);
      } else {
        provider.updateMessage.mockImplementationOnce(async () => {
          await takeOver();
          return true;
        });
        await updateSlackThreadMessageWithFooterText({
          ...params,
          messageTs: 'orphan',
        });
      }
      expect(mocks.current).toBe('new');
      expect(provider.updateMessage).toHaveBeenLastCalledWith({
        channel: 'C',
        ts: 'orphan',
        message: { blocks: [body, image] },
      });
      expect(provider.updateMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ ts: 'old' }),
      );
      expect(provider.updateMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ ts: 'new' }),
      );
      warning.mockRestore();
    },
  );

  it('forgets a missing provider message without posting or looking through history', async () => {
    const provider = slack();
    provider.getMessageBlocks.mockResolvedValueOnce(null);
    await refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    expect(mocks.forget).toHaveBeenCalledWith({
      provider: 'slack',
      channelId: 'C',
      threadId: 'T',
    });
    expect(provider.getMessageBlocks).toHaveBeenCalledTimes(1);
    expect(provider.updateMessage).not.toHaveBeenCalled();
    expect(provider.postMessage).not.toHaveBeenCalled();
  });

  it('does not forget a competitor when the lease is lost during the missing-message lookup', async () => {
    const provider = slack();
    provider.getMessageBlocks.mockImplementationOnce(async () => {
      mocks.store.set('slack:thread_reply_footer_lock:C:T', 'competitor');
      mocks.current = 'new';
      return null;
    });
    await expect(
      refreshSlackThreadReplyFooter({
        slack: provider,
        channel: 'C',
        threadTs: 'T',
      }),
    ).rejects.toThrow('lease lost');
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it('skips unchanged, missing and already footerless messages without history lookup or posting', async () => {
    const provider = slack();
    mocks.current = '';
    await refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    expect(provider.getMessageBlocks).not.toHaveBeenCalled();
    expect(mocks.forget).toHaveBeenCalled();
    mocks.current = 'old';
    mocks.resolve.mockResolvedValue('idle');
    await refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    provider.getMessageBlocks.mockResolvedValueOnce([body, image]);
    await refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    expect(provider.updateMessage).not.toHaveBeenCalled();
    expect(provider.postMessage).not.toHaveBeenCalled();
  });

  it('serializes relocation with a paused refresh, then reads the new pointer on the next tick', async () => {
    const provider = slack();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.resolve.mockImplementationOnce(async () => {
      started();
      await gate;
      return 'running';
    });
    const refresh = refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    await ready;
    const post = postSlackThreadMessageWithFooterText({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
      text: 'New body',
      bodyBlocks: [body],
      footerText: 'running',
    });
    expect(provider.postMessage).not.toHaveBeenCalled();
    release();
    await refresh;
    await post;
    expect(mocks.current).toBe('new');
    provider.updateMessage.mockClear();
    await refreshSlackThreadReplyFooter({
      slack: provider,
      channel: 'C',
      threadTs: 'T',
    });
    expect(provider.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 'new' }),
    );
    expect(provider.updateMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ ts: 'old' }),
    );
  });
});
