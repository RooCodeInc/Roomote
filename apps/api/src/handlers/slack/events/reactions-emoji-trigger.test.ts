import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfiguration: vi.fn(),
  handleMessage: vi.fn(),
}));

vi.mock('../../call-roomote-via-emoji.js', () => ({
  resolveReactionTaskEntry: async (input: {
    reaction: string;
    requester: { id: string; name: string };
    sourceEventId: string;
    target: { channelId: string; messageId: string; threadId?: string };
  }) => {
    const { reaction, ...entry } = input;
    const configuration = await mocks.getConfiguration(reaction);
    return configuration ? { ...entry, prompt: configuration.prompt } : null;
  },
}));

vi.mock('./message-entry.js', () => ({
  handleSlackReactionTaskEntry: mocks.handleMessage,
}));

import {
  handleReactionAddedEvent,
  maybeCallRoomoteViaEmoji,
} from './reactions';

describe('Slack emoji trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('turns a configured reaction into an explicit task entry', async () => {
    mocks.getConfiguration.mockResolvedValue({
      emoji: 'white_check_mark',
      prompt: 'Act on this\n\nAdditional instructions:\nPrioritize safety.',
    });
    const getMessage = vi.fn().mockResolvedValue({
      ts: '1710000000.000100',
      thread_ts: '1710000000.000000',
      text: 'Please investigate this.',
    });
    const context = {
      teamId: 'T1',
      slackInstallation: { botUserId: 'UROOMOTE' },
      slack: { getMessage },
    };
    const event = {
      type: 'reaction_added' as const,
      user: 'U1',
      reaction: 'white_check_mark',
      item: {
        type: 'message' as const,
        channel: 'C1',
        ts: '1710000000.000100',
      },
      event_ts: '1710000001.000000',
    };

    await expect(
      maybeCallRoomoteViaEmoji({
        context: context as never,
        event,
      }),
    ).resolves.toBe(true);

    expect(mocks.handleMessage).toHaveBeenCalledWith({
      context,
      entry: {
        prompt: 'Act on this\n\nAdditional instructions:\nPrioritize safety.',
        requester: { id: 'U1', name: 'U1' },
        sourceEventId: '1710000001.000000',
        target: {
          channelId: 'C1',
          messageId: '1710000000.000100',
          threadId: '1710000000.000000',
        },
      },
    });
  });

  it('does nothing when the reaction is not configured', async () => {
    mocks.getConfiguration.mockResolvedValue(null);

    await expect(
      maybeCallRoomoteViaEmoji({
        context: {} as never,
        event: {
          type: 'reaction_added',
          user: 'U1',
          reaction: 'eyes',
          item: { type: 'message', channel: 'C1', ts: '1' },
          event_ts: '2',
        },
      }),
    ).resolves.toBe(false);
  });

  it('gives the configured trigger precedence over thumbs-up suggestion actions', async () => {
    mocks.getConfiguration.mockResolvedValue({
      emoji: 'thumbsup',
      prompt: 'Act on this',
    });
    const context = {
      teamId: 'T1',
      slackInstallation: { botUserId: 'UROOMOTE' },
      slack: {
        getMessage: vi.fn().mockResolvedValue({
          ts: '1710000000.000100',
          text: 'A suggested task.',
        }),
      },
    };

    await handleReactionAddedEvent({
      context: context as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: '1710000000.000100' },
        event_ts: '1710000001.000000',
      },
    });

    expect(mocks.handleMessage).toHaveBeenCalledTimes(1);
    expect(mocks.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ prompt: 'Act on this' }),
      }),
    );
  });
});
