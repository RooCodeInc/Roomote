import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAutomationRuntime = vi.hoisted(() => vi.fn());

vi.mock('@roomote/db/server', () => ({
  getAutomationRuntime,
}));

import {
  CALL_ROOMOTE_VIA_EMOJI_PROMPT,
  getCallRoomoteViaEmojiConfiguration,
  resolveReactionTaskEntry,
} from './call-roomote-via-emoji';

describe('Call Roomote via emoji configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the exact default prompt when no instructions are configured', async () => {
    getAutomationRuntime.mockResolvedValue({
      enabled: true,
      instructions: null,
      settings: { emoji: ':white_check_mark:' },
    });

    await expect(getCallRoomoteViaEmojiConfiguration('✅')).resolves.toEqual({
      emoji: ':white_check_mark:',
      prompt: 'Act on this',
    });
    expect(CALL_ROOMOTE_VIA_EMOJI_PROMPT).toBe('Act on this');
  });

  it('appends configured instructions after the default prompt', async () => {
    getAutomationRuntime.mockResolvedValue({
      enabled: true,
      instructions: 'Prioritize safety.',
      settings: { emoji: 'white_check_mark' },
    });

    await expect(
      getCallRoomoteViaEmojiConfiguration('white_check_mark'),
    ).resolves.toMatchObject({
      prompt: 'Act on this\n\nAdditional instructions:\nPrioritize safety.',
    });
  });

  it('returns the explicit task-entry contract for a configured reaction', async () => {
    getAutomationRuntime.mockResolvedValue({
      enabled: true,
      instructions: null,
      settings: { emoji: 'white_check_mark' },
    });

    await expect(
      resolveReactionTaskEntry({
        reaction: 'white_check_mark',
        requester: { id: 'provider-user-1', name: 'Ada Lovelace' },
        sourceEventId: 'reaction-event-1',
        target: {
          channelId: 'channel-1',
          messageId: 'message-1',
          threadId: 'thread-1',
        },
      }),
    ).resolves.toEqual({
      prompt: 'Act on this',
      requester: { id: 'provider-user-1', name: 'Ada Lovelace' },
      sourceEventId: 'reaction-event-1',
      target: {
        channelId: 'channel-1',
        messageId: 'message-1',
        threadId: 'thread-1',
      },
    });
  });

  it('ignores disabled and non-matching reactions', async () => {
    getAutomationRuntime.mockResolvedValue({
      enabled: false,
      instructions: null,
      settings: { emoji: 'eyes' },
    });
    await expect(
      getCallRoomoteViaEmojiConfiguration('eyes'),
    ).resolves.toBeNull();

    getAutomationRuntime.mockResolvedValue({
      enabled: true,
      instructions: null,
      settings: { emoji: 'eyes' },
    });
    await expect(
      getCallRoomoteViaEmojiConfiguration('fire'),
    ).resolves.toBeNull();
  });
});
