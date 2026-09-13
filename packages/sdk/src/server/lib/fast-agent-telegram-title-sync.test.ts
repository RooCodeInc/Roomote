import { describe, expect, it, vi } from 'vitest';

import {
  TELEGRAM_TOPIC_ICON_EMOJIS,
  type FastAgentConversationRecord,
} from '@roomote/cloud-agents/server';

import {
  addFastAgentTelegramTopicTitleSync,
  syncFastAgentTelegramTopicTitleBestEffort,
} from './fast-agent-telegram-title-sync';
import {
  FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS,
  createFastAgentTelegramActivity,
} from './fast-agent-telegram-activity';

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
      iconEmoji: '🦠',
      resolveSession,
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Fix generated title',
      iconCustomEmojiId: 'idea-icon',
    });
    expect(resolveForumTopicIconCustomEmojiId).toHaveBeenCalledWith(['🦠']);
  });

  it('exposes the complete deduplicated Telegram topic-icon inventory', () => {
    expect(TELEGRAM_TOPIC_ICON_EMOJIS).toHaveLength(112);
    expect(new Set(TELEGRAM_TOPIC_ICON_EMOJIS).size).toBe(112);
    expect(TELEGRAM_TOPIC_ICON_EMOJIS).toEqual(
      expect.arrayContaining(['📰', '💡', '🦠', '💬', '🧠', '🐈']),
    );
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

    activity.updateTitle?.('Generated title', { iconEmoji: '💬' });
    activity.updateTitle?.('Generated title', { iconEmoji: '💬' });
    await activity.dispose();

    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('restores working activity after a topic update clears the draft', async () => {
    vi.useFakeTimers();
    try {
      const sendRichMessageDraft = vi.fn().mockResolvedValue(undefined);
      const currentSession = session('Generated title');
      if (currentSession.conversation.surface !== 'telegram') {
        throw new Error('Expected a Telegram session.');
      }
      currentSession.conversation.replyTarget = {
        channelId: '123',
        threadId: '77',
      };
      const baseActivity = createFastAgentTelegramActivity({
        provider: { sendRichMessageDraft, sendChatAction: vi.fn() },
        replyTarget: { channelId: '123', threadId: '77' },
      });
      const activity = addFastAgentTelegramTopicTitleSync({
        activity: baseActivity,
        provider: {
          editForumTopic: vi.fn().mockResolvedValue(undefined),
          resolveForumTopicIconCustomEmojiId: vi
            .fn()
            .mockResolvedValue(undefined),
        } as never,
        sessionId: 'session-1',
        channelId: '123',
        threadId: '77',
        resolveSession: vi.fn().mockResolvedValue(currentSession),
      });

      activity.start();
      await vi.advanceTimersByTimeAsync(
        FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS,
      );
      expect(sendRichMessageDraft).toHaveBeenCalledOnce();

      activity.updateTitle?.('Generated title', { titleChanged: true });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(
        FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS,
      );
      expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
      expect(sendRichMessageDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'Roomote is working...' }),
      );
      await activity.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates only the icon when a generated canonical title is unchanged', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: {
        editForumTopic,
        resolveForumTopicIconCustomEmojiId: vi
          .fn()
          .mockResolvedValue('idea-icon'),
      } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      iconEmoji: '💡',
      titleChanged: false,
      resolveSession: vi.fn().mockResolvedValue(session('Generated title')),
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      iconCustomEmojiId: 'idea-icon',
    });
  });

  it('skips Telegram when neither the canonical title nor icon changed', async () => {
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
      iconEmoji: null,
      titleChanged: false,
      resolveSession: vi.fn().mockResolvedValue(session('Generated title')),
    });

    expect(editForumTopic).not.toHaveBeenCalled();
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
    ).resolves.toBe(false);
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
      iconEmoji: '💡',
      resolveSession: vi.fn().mockResolvedValue(session('Generated title')),
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Generated title',
    });
  });

  it('keeps the title when Telegram does not support the selected icon', async () => {
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
      iconEmoji: '🦠',
      resolveSession: vi.fn().mockResolvedValue(session('Fix generated title')),
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Fix generated title',
    });
  });

  it('preserves the existing icon when no new icon is supplied', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);
    const resolveForumTopicIconCustomEmojiId = vi.fn();

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: {
        editForumTopic,
        resolveForumTopicIconCustomEmojiId,
      } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      iconEmoji: null,
      resolveSession: vi.fn().mockResolvedValue(session('Existing title')),
    });

    expect(resolveForumTopicIconCustomEmojiId).not.toHaveBeenCalled();
    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Existing title',
    });
  });
});
