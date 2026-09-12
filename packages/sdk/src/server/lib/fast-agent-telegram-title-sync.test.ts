import { describe, expect, it, vi } from 'vitest';

import type { FastAgentConversationRecord } from '@roomote/cloud-agents/server';

import {
  addFastAgentTelegramTopicTitleSync,
  getTelegramTopicIconEmojiPreferences,
  syncFastAgentTelegramTopicTitleBestEffort,
} from './fast-agent-telegram-title-sync';

function session(title: string): FastAgentConversationRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    owner: { kind: 'user', userId: 'user-1' },
    title,
    model: null,
    reasoningEffort: null,
    conversation: {
      surface: 'telegram',
      workspaceId: 'chat-1',
      conversationId: '77:user:user-1',
      replyTarget: { channelId: 'chat-1', threadId: '77' },
    },
    compatibilityMessages: [],
    openCodeSessionId: null,
  };
}

describe('Telegram Fast topic title sync', () => {
  it('replaces the provisional topic title with the generated Session title', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);
    const resolveForumTopicIconCustomEmojiId = vi
      .fn()
      .mockResolvedValue('idea-icon');
    const resolveSession = vi
      .fn()
      .mockResolvedValue(session('Fix generated title'));

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: {
        editForumTopic,
        resolveForumTopicIconCustomEmojiId,
      } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      resolveSession,
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Fix generated title',
      iconCustomEmojiId: 'idea-icon',
    });
    expect(resolveForumTopicIconCustomEmojiId).toHaveBeenCalledWith([
      '🐞',
      '🛠',
      '💡',
      '💬',
      '📝',
    ]);
  });

  it.each([
    ['Investigate auth permissions', '🔒'],
    ['Fix login regression', '🐞'],
    ['Verify CI test coverage', '✅'],
    ['Prepare release deployment', '🚀'],
    ['Update documentation guide', '📚'],
    ['Polish frontend design', '🎨'],
    ['Review database metrics', '📊'],
    ['Improve Telegram integration', '💬'],
  ])('classifies %s with %s as its first icon preference', (title, emoji) => {
    expect(getTelegramTopicIconEmojiPreferences(title)[0]).toBe(emoji);
  });

  it('uses deterministic general-purpose preferences when no pattern matches', () => {
    expect(
      getTelegramTopicIconEmojiPreferences('Plan quarterly priorities'),
    ).toEqual(['💡', '💬', '📝']);
  });

  it('retries with the latest canonical title when generation races a rename', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);
    const resolveForumTopicIconCustomEmojiId = vi
      .fn()
      .mockResolvedValue(undefined);
    const resolveSession = vi
      .fn()
      .mockResolvedValueOnce(session('First generated title'))
      .mockResolvedValueOnce(session('Newer generated title'))
      .mockResolvedValue(session('Newer generated title'));

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: { editForumTopic, resolveForumTopicIconCustomEmojiId } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      resolveSession,
    });

    expect(editForumTopic).toHaveBeenNthCalledWith(1, {
      channelId: 'chat-1',
      threadId: '77',
      name: 'First generated title',
    });
    expect(editForumTopic).toHaveBeenNthCalledWith(2, {
      channelId: 'chat-1',
      threadId: '77',
      name: 'Newer generated title',
    });
  });

  it('serializes updates and ignores duplicate title notifications', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const activity = addFastAgentTelegramTopicTitleSync({
      activity: {
        start: vi.fn(),
        settle: vi.fn().mockResolvedValue(undefined),
        dispose,
        reassert: vi.fn(),
      },
      provider: {
        editForumTopic,
        resolveForumTopicIconCustomEmojiId: vi
          .fn()
          .mockResolvedValue(undefined),
      } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      resolveSession: vi.fn().mockResolvedValue(session('Generated title')),
    });

    activity.updateTitle?.('Generated title');
    activity.updateTitle?.('Generated title');
    await activity.dispose();

    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps Telegram failures non-fatal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      syncFastAgentTelegramTopicTitleBestEffort({
        provider: {
          editForumTopic: vi.fn().mockRejectedValue(new Error('forbidden')),
          resolveForumTopicIconCustomEmojiId: vi
            .fn()
            .mockResolvedValue(undefined),
        } as never,
        sessionId: 'session-1',
        channelId: 'chat-1',
        threadId: '77',
        resolveSession: vi.fn().mockResolvedValue(session('Generated title')),
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to sync Telegram topic title'),
    );
    warn.mockRestore();
  });

  it('still updates the title when supported icon lookup fails', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: {
        editForumTopic,
        resolveForumTopicIconCustomEmojiId: vi
          .fn()
          .mockRejectedValue(new Error('icons unavailable')),
      } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      resolveSession: vi.fn().mockResolvedValue(session('Generated title')),
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Generated title',
    });
  });

  it('keeps the title when Telegram supports none of the classified emojis', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: {
        editForumTopic,
        resolveForumTopicIconCustomEmojiId: vi
          .fn()
          .mockResolvedValue(undefined),
      } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      resolveSession: vi.fn().mockResolvedValue(session('Fix generated title')),
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Fix generated title',
    });
  });
});
