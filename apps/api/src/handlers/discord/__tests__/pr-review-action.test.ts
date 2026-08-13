const mocks = vi.hoisted(() => ({
  claimPending: vi.fn(),
  dispatchFollowUp: vi.fn(),
  findMappedUser: vi.fn(),
  reply: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  claimPendingPrReviewAction: mocks.claimPending,
  claimPendingPrReviewActionsForThread: vi.fn(),
  dispatchPrReviewFollowUp: mocks.dispatchFollowUp,
  enableAutoHandlePrReviewFeedback: vi.fn(),
  findDiscordMappedUserId: mocks.findMappedUser,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

import { handleDiscordPrReviewActionCallback } from '../pr-review-action.js';

describe('handleDiscordPrReviewActionCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMappedUser.mockResolvedValue('user-1');
    mocks.claimPending.mockResolvedValue({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      channelId: 'channel-1',
      threadId: 'thread-1',
      followUpPrompt: 'Address the feedback.',
    });
    mocks.dispatchFollowUp.mockResolvedValue({ outcome: 'queued' });
  });

  it('preserves the feedback card and renders the resolution as subtext', async () => {
    await handleDiscordPrReviewActionCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        user: { id: 'discord-user-1', username: 'dan' },
        message: {
          id: 'message-1',
          channel_id: 'thread-1',
          content: 'Review feedback: add a regression test.',
          author: { id: 'bot-1', username: 'Roomote' },
          attachments: [],
          mentions: [],
        },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Task thread',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      choice: 'auto',
      nonce: 'nonce-1',
    });

    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Review feedback: add a regression test.\n\n-# I'll resolve these and any future feedback on this PR automatically. Starting on the current feedback now.",
      }),
    );
    expect(mocks.reply.mock.calls[0]?.[0]).not.toHaveProperty('buttons');
    expect(mocks.dispatchFollowUp).toHaveBeenCalledWith({
      provider: 'discord',
      taskId: 'task-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      followUpPrompt: 'Address the feedback.',
      actingUserId: 'user-1',
      providerUserId: 'discord-user-1',
    });
  });

  it('keeps the feedback visible when the offer was already claimed', async () => {
    mocks.claimPending.mockResolvedValue(null);

    await handleDiscordPrReviewActionCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        user: { id: 'discord-user-1', username: 'dan' },
        message: {
          id: 'message-1',
          channel_id: 'thread-1',
          content: 'Review feedback: add a regression test.',
          author: { id: 'bot-1', username: 'Roomote' },
          attachments: [],
          mentions: [],
        },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Task thread',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      choice: 'yes',
      nonce: 'nonce-1',
    });

    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Review feedback: add a regression test.\n\n-# This offer was already handled or has expired.',
      }),
    );
  });

  it('renders the resolution as subtext when the feedback is empty', async () => {
    mocks.claimPending.mockResolvedValue(null);

    await handleDiscordPrReviewActionCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        user: { id: 'discord-user-1', username: 'dan' },
        message: {
          id: 'message-1',
          channel_id: 'thread-1',
          content: '',
          author: { id: 'bot-1', username: 'Roomote' },
          attachments: [],
          mentions: [],
        },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Task thread',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      choice: 'yes',
      nonce: 'nonce-1',
    });

    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '-# This offer was already handled or has expired.',
      }),
    );
  });

  it('truncates preserved feedback to fit the action resolution', async () => {
    const content = 'x'.repeat(2_000);

    await handleDiscordPrReviewActionCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        user: { id: 'discord-user-1', username: 'dan' },
        message: {
          id: 'message-1',
          channel_id: 'thread-1',
          content,
          author: { id: 'bot-1', username: 'Roomote' },
          attachments: [],
          mentions: [],
        },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Task thread',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      choice: 'yes',
      nonce: 'nonce-1',
    });

    const text = mocks.reply.mock.calls[0]?.[0]?.text;
    expect(text).toHaveLength(2_000);
    expect(text).toMatch(
      /\.\.\.\n\n-# On it — resolving the review feedback\.$/,
    );
  });
});
