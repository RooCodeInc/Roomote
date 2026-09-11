import { describe, expect, it, vi } from 'vitest';

import type { FastAgentConversationRecord } from '@roomote/cloud-agents/server';

import {
  addFastAgentTelegramTopicTitleSync,
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
    const resolveSession = vi
      .fn()
      .mockResolvedValue(session('Generated title'));

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: { editForumTopic } as never,
      sessionId: 'session-1',
      channelId: 'chat-1',
      threadId: '77',
      resolveSession,
    });

    expect(editForumTopic).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: '77',
      name: 'Generated title',
    });
  });

  it('retries with the latest canonical title when generation races a rename', async () => {
    const editForumTopic = vi.fn().mockResolvedValue(undefined);
    const resolveSession = vi
      .fn()
      .mockResolvedValueOnce(session('First generated title'))
      .mockResolvedValueOnce(session('Newer generated title'))
      .mockResolvedValue(session('Newer generated title'));

    await syncFastAgentTelegramTopicTitleBestEffort({
      provider: { editForumTopic } as never,
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
      provider: { editForumTopic } as never,
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
});
