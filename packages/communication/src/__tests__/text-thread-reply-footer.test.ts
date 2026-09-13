import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsCommunicationProvider } from '../teams-provider';
import type { TelegramCommunicationProvider } from '../telegram-provider';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  resolve: vi.fn(),
}));
vi.mock('../thread-footer-refresh', () => ({
  resolveCurrentThreadFooterText: mocks.resolve,
  resolveCurrentThreadFooter: async (provider: string, footerText: string) => {
    const text = await mocks.resolve(provider, footerText);
    return text === null ? null : { text, active: true, settled: false };
  },
  scheduleThreadFooterRefresh: vi.fn().mockResolvedValue(undefined),
  forgetThreadFooterRefresh: vi.fn(),
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
      script: string,
      count: number,
      key: string,
      ...args: string[]
    ) => {
      const owner = args[count - 1];
      if (mocks.store.get(key) !== owner) return 0;
      if (count === 2) {
        const [pointerKey, , value, ttl] = args;
        if (ttl !== 'keepTtl' || mocks.store.has(pointerKey!))
          mocks.store.set(pointerKey!, value!);
      } else if (script.includes("'del'")) mocks.store.delete(key);
      return 1;
    },
  }),
}));

import {
  postTextThreadReplyWithFooter,
  replaceTextThreadReplyWithFooter,
} from '../text-thread-reply-footer';
import { getThreadReplyFooterRecord } from '../thread-reply-footer-state';
import { refreshManagedThreadReplyFooter } from '../thread-reply-footer-delivery';
import { editTextThreadFooterMessage } from '../text-thread-reply-footer';

describe('text provider current carriers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.resolve.mockResolvedValue('current footer');
  });

  it('Teams retains attachments and service routing on refresh, relocation and current replacement', async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({
        provider: 'teams',
        channelId: 'C',
        messageId: '1',
      })
      .mockResolvedValueOnce({
        provider: 'teams',
        channelId: 'C',
        messageId: '2',
      });
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const provider = {
      provider: 'teams',
      postMessage,
      updateMessage,
    } as unknown as TeamsCommunicationProvider;
    const images = [{ url: 'https://image', altText: 'proof' }];
    await postTextThreadReplyWithFooter({
      provider,
      input: {
        channelId: 'C',
        threadId: 'T',
        serviceUrl: 'https://service',
        text: 'Body',
        images,
      },
      footerText: 'old footer',
    });
    // Like Slack and Discord, the caller's footer is posted as written.
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Body\n\nold footer', images }),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    mocks.resolve.mockResolvedValue('idle with live preview');
    await refreshManagedThreadReplyFooter({
      provider: 'teams',
      channelId: 'C',
      threadId: 'T',
      edit: (record, text) =>
        editTextThreadFooterMessage(provider, record, text),
    });
    expect(updateMessage).toHaveBeenLastCalledWith({
      channelId: 'C',
      messageId: '1',
      serviceUrl: 'https://service',
      text: 'Body\n\nidle with live preview',
      textFormat: 'markdown',
      images,
    });
    await replaceTextThreadReplyWithFooter({
      provider,
      channelId: 'C',
      threadId: 'T',
      serviceUrl: 'https://service',
      messageId: '1',
      text: 'Updated body',
    });
    await postTextThreadReplyWithFooter({
      provider,
      input: {
        channelId: 'C',
        threadId: 'T',
        serviceUrl: 'https://service',
        text: 'New reply',
      },
      footerText: 'old footer',
    });
    expect(updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: '1', text: 'Updated body', images }),
    );
    await replaceTextThreadReplyWithFooter({
      provider,
      channelId: 'C',
      threadId: 'T',
      serviceUrl: 'https://service',
      messageId: '1',
      text: 'Historical update',
    });
    expect(updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: '1', text: 'Historical update' }),
    );
    expect(
      (await getThreadReplyFooterRecord('teams', 'C', 'T'))?.messageId,
    ).toBe('2');
  });

  it('Telegram records the final text chunk and preserves its buttons on refresh', async () => {
    const postMessage = vi.fn().mockResolvedValue({
      provider: 'telegram',
      channelId: 'C',
      messageId: 'first',
      lastTextMessageId: 'last',
    });
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const provider = {
      provider: 'telegram',
      postMessage,
      editMessageText,
    } as unknown as TelegramCommunicationProvider;
    const buttons = [[{ text: 'Open', url: 'https://app' }]];
    const body = `${'Long narrative. '.repeat(400)}\n\nFinal paragraph`;
    const posted = await postTextThreadReplyWithFooter({
      provider,
      input: { channelId: 'C', text: body, buttons },
      footerText: 'old footer',
    });
    expect(postMessage).toHaveBeenCalledWith({
      channelId: 'C',
      text: body,
      footerText: 'old footer',
      buttons,
      textFormat: 'markdown',
    });
    expect(posted.messageId).toBe('last');
    const record = await getThreadReplyFooterRecord('telegram', 'C', 'root');
    expect(record?.textWithoutFooter.endsWith('Final paragraph')).toBe(true);
    expect(record?.textWithoutFooter).toBe(body);
    expect(record?.buttons).toEqual(buttons);
    mocks.resolve.mockResolvedValue('No running tasks');
    await refreshManagedThreadReplyFooter({
      provider: 'telegram',
      channelId: 'C',
      threadId: 'root',
      edit: (current, text) =>
        editTextThreadFooterMessage(provider, current, text),
    });
    expect(editMessageText).toHaveBeenCalledWith({
      channelId: 'C',
      messageId: 'last',
      text: record?.textWithoutFooter,
      footerText: 'No running tasks',
      textFormat: 'markdown',
      buttons,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
