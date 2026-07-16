const mocks = vi.hoisted(() => ({
  getAvailableEnvironments: vi.fn(),
  getTaskUrl: vi.fn(),
  findMappedUser: vi.fn(),
  findSourceRun: vi.fn(),
  launchTask: vi.fn(),
  reserveAnchoredThread: vi.fn(),
  forgetPendingTaskThread: vi.fn(),
  resolveWorkspace: vi.fn(),
  reply: vi.fn(),
  redisSet: vi.fn(),
  redisGetdel: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getAvailableEnvironments: mocks.getAvailableEnvironments,
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('@roomote/sdk/server', () => ({
  findDiscordMappedUserId: mocks.findMappedUser,
}));

vi.mock('../../tasks/communication-task-run-lookup.js', () => ({
  findCommunicationTaskRunBySourceEvent: mocks.findSourceRun,
}));

vi.mock('../task-launch.js', () => ({
  launchDiscordTask: mocks.launchTask,
  reserveDiscordAnchoredThread: mocks.reserveAnchoredThread,
  forgetPendingTaskThread: mocks.forgetPendingTaskThread,
  resolveDiscordWorkspace: mocks.resolveWorkspace,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ set: mocks.redisSet, getdel: mocks.redisGetdel }),
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

import {
  handleDiscordRoutingCallback,
  requestDiscordRoutingConfirmation,
  shouldAutoConfirmDiscordRoute,
} from '../routing-confirmation.js';

describe('Discord routing confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAvailableEnvironments.mockResolvedValue([
      { id: 'env-1', name: 'Sunny Acres', repositoryNames: ['acme/game'] },
      { id: 'env-2', name: 'API', repositoryNames: ['acme/api'] },
    ]);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.reserveAnchoredThread.mockResolvedValue(null);
    mocks.forgetPendingTaskThread.mockResolvedValue(undefined);
    mocks.findMappedUser.mockResolvedValue('user-1');
    mocks.findSourceRun.mockResolvedValue(null);
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/task/task-1');
    mocks.resolveWorkspace.mockResolvedValue({
      environmentId: 'env-1',
      repoForPayload: 'acme/game',
      workspaceDisplayName: 'Sunny Acres',
    });
    mocks.launchTask.mockResolvedValue({
      createdThread: { channelId: 'thread-1' },
      taskUrl: 'https://roomote.example/task/task-1',
      launchResult: { id: 42, taskId: 'task-1' },
    });
    mocks.reply.mockResolvedValue({ messageId: 'confirmation-1' });
  });

  it('auto-confirms only high-confidence, unremapped routes', () => {
    expect(
      shouldAutoConfirmDiscordRoute({
        status: 'routed',
        result: {
          workspace: { type: 'environment', id: 'env-1', name: 'Sunny Acres' },
          reasoning: 'match',
          debug: {
            phase: 'direct',
            toolsUsed: [],
            needsExternalLookup: false,
            confidence: 0.95,
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldAutoConfirmDiscordRoute({
        status: 'routed',
        result: {
          workspace: { type: 'environment', id: 'env-1', name: 'Sunny Acres' },
          reasoning: 'weak match',
          debug: {
            phase: 'direct',
            toolsUsed: [],
            needsExternalLookup: false,
            confidence: 0.94,
          },
        },
      }),
    ).toBe(false);
  });

  it('persists a pending route and posts workspace buttons', async () => {
    await requestDiscordRoutingConfirmation({
      provider: {} as never,
      applicationId: 'app-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      routingDecision: {
        status: 'routed',
        result: {
          workspace: { type: 'environment', id: 'env-1', name: 'Sunny Acres' },
          reasoning: 'likely',
          debug: {
            phase: 'direct',
            toolsUsed: [],
            needsExternalLookup: false,
            confidence: 0.7,
          },
        },
      },
    });

    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^discord:pending_route:/u),
      expect.stringContaining('Fix matchmaking'),
      'EX',
      900,
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Sunny Acres'),
        buttons: expect.arrayContaining([
          [
            expect.objectContaining({
              text: 'Sunny Acres',
              callbackData: expect.stringMatching(/^discord:route:/u),
            }),
          ],
        ]),
      }),
    );
  });

  it('carries the thread anchor through the pending route to the launch', async () => {
    // A confirmation card defers the launch to a button interaction, which
    // has no message of its own. The anchor from the original mention must
    // survive the round trip or the task thread silently detaches.
    await requestDiscordRoutingConfirmation({
      provider: {} as never,
      applicationId: 'app-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
        communicationAnchorMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      routingDecision: {
        status: 'routed',
        result: {
          workspace: { type: 'environment', id: 'env-1', name: 'Sunny Acres' },
          reasoning: 'likely',
          debug: {
            phase: 'direct',
            toolsUsed: [],
            needsExternalLookup: false,
            confidence: 0.7,
          },
        },
      },
    });

    const stored = mocks.redisSet.mock.calls[0]?.[1] as string;
    expect(JSON.parse(stored).metadata).toMatchObject({
      communicationAnchorMessageId: 'message-1',
    });
  });

  it('asks inside the task thread so the channel only shows the request', async () => {
    // Slack posts its routing card into the thread on the requesting message.
    // Reserving the thread up front is what lets Discord do the same; the
    // launch then reuses that thread rather than opening a second one.
    mocks.reserveAnchoredThread.mockResolvedValue({
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'Fix matchmaking',
      kind: 'thread',
      messageId: 'message-1',
    });

    await requestDiscordRoutingConfirmation({
      provider: {} as never,
      applicationId: 'app-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
        communicationAnchorMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      routingDecision: { status: 'fallback', reason: 'ambiguous' },
    });

    expect(mocks.reply.mock.lastCall?.[0]?.channel).toMatchObject({
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      isThread: true,
    });
    const stored = JSON.parse(mocks.redisSet.mock.calls[0]?.[1] as string);
    expect(stored.cardChannel).toMatchObject({ channelId: 'message-1' });
    // The launch still receives the root channel, so it resolves the same
    // thread parent and finds the reservation.
    expect(stored.channel).toMatchObject({
      channelId: 'channel-1',
      isThread: false,
    });
  });

  it('asks in the channel when the request cannot anchor a thread', async () => {
    mocks.reserveAnchoredThread.mockResolvedValue(null);

    await requestDiscordRoutingConfirmation({
      provider: {} as never,
      applicationId: 'app-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'dm-1',
        communicationMessageId: 'message-1',
      },
      channel: {
        channelId: 'dm-1',
        channelName: 'Direct message',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
      routingDecision: { status: 'fallback', reason: 'ambiguous' },
    });

    expect(mocks.reply.mock.lastCall?.[0]?.channel).toMatchObject({
      channelId: 'dm-1',
    });
    expect(
      JSON.parse(mocks.redisSet.mock.calls[0]?.[1] as string).cardChannel,
    ).toBeUndefined();
  });

  it('still asks in the channel when reserving the thread fails', async () => {
    // Card placement is cosmetic; the launch retries the thread itself.
    // Losing the whole request over it would not be.
    mocks.reserveAnchoredThread.mockRejectedValue(new Error('Discord 503'));

    await requestDiscordRoutingConfirmation({
      provider: {} as never,
      applicationId: 'app-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
        communicationAnchorMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      routingDecision: { status: 'fallback', reason: 'ambiguous' },
    });

    expect(mocks.reply.mock.lastCall?.[0]?.channel).toMatchObject({
      channelId: 'channel-1',
    });
  });

  it('keeps every stored route visible within Discord action-row limits', async () => {
    mocks.getAvailableEnvironments.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `env-${index + 1}`,
        name: `Environment ${index + 1}`,
        repositoryNames: [`acme/repo-${index + 1}`],
      })),
    );

    await requestDiscordRoutingConfirmation({
      provider: {} as never,
      applicationId: 'app-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      routingDecision: { status: 'fallback', reason: 'ambiguous' },
    });

    const buttons = mocks.reply.mock.lastCall?.[0]?.buttons as Array<
      Array<{ text: string }>
    >;
    expect(buttons).toHaveLength(5);
    expect(buttons.flat().map((button) => button.text)).toContain(
      'All repositories',
    );
    expect(buttons.at(-1)).toEqual([
      expect.objectContaining({ text: 'Nevermind' }),
    ]);
  });

  it('does not launch again when a retried route click already created the task', async () => {
    mocks.redisGetdel.mockResolvedValue(
      JSON.stringify({
        requesterDiscordUserId: 'discord-user-1',
        launchOwnerUserId: 'user-1',
        queuedMessage: {
          provider: 'discord',
          text: 'Fix matchmaking',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-1',
        },
        metadata: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'message-1',
        },
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType: 0,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
        options: [
          {
            label: 'Sunny Acres',
            workspace: {
              type: 'environment',
              id: 'env-1',
              name: 'Sunny Acres',
            },
          },
        ],
      }),
    );
    mocks.findSourceRun.mockResolvedValue({ id: 41, taskId: 'task-1' });

    await handleDiscordRoutingCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'channel-1',
        user: { id: 'discord-user-1', username: 'matt' },
        data: { custom_id: 'discord:route:abcdefghijkl:0' },
      },
      interactionDeferred: true,
      callback: { pendingRouteId: 'abcdefghijkl', selection: 0 },
    });

    expect(mocks.launchTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('task-1') }),
    );
  });

  it('restores the route choice when launching fails so delivery can retry', async () => {
    const pending = {
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix matchmaking',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      options: [
        {
          label: 'Sunny Acres',
          workspace: {
            type: 'environment',
            id: 'env-1',
            name: 'Sunny Acres',
          },
        },
      ],
    };
    mocks.redisGetdel.mockResolvedValue(JSON.stringify(pending));
    mocks.launchTask.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      handleDiscordRoutingCallback({
        provider: {} as never,
        applicationId: 'app-1',
        interaction: {
          id: 'interaction-1',
          application_id: 'app-1',
          type: 3,
          token: 'token-1',
          channel_id: 'channel-1',
          user: { id: 'discord-user-1', username: 'matt' },
          data: { custom_id: 'discord:route:abcdefghijkl:0' },
        },
        interactionDeferred: true,
        callback: { pendingRouteId: 'abcdefghijkl', selection: 0 },
      }),
    ).rejects.toThrow('queue unavailable');

    expect(mocks.redisSet).toHaveBeenCalledWith(
      'discord:pending_route:abcdefghijkl',
      JSON.stringify(pending),
      'EX',
      900,
    );
  });

  it('accepts the requester pressing a button inside the task thread', async () => {
    // A card posted into the thread reports the thread as its channel. Matching
    // the interaction against the originating channel would read the requester
    // as an impostor and refuse every launch.
    mocks.redisGetdel.mockResolvedValue(
      JSON.stringify({
        requesterDiscordUserId: 'discord-user-1',
        launchOwnerUserId: 'user-1',
        queuedMessage: {
          provider: 'discord',
          text: 'Fix matchmaking',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-1',
        },
        metadata: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'message-1',
          communicationAnchorMessageId: 'message-1',
        },
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType: 0,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
        cardChannel: {
          channelId: 'message-1',
          channelName: 'Fix matchmaking',
          channelType: 11,
          guildId: 'guild-1',
          parentChannelId: 'channel-1',
          isDirectMessage: false,
          isThread: true,
        },
        options: [
          {
            label: 'Sunny Acres',
            workspace: {
              type: 'environment',
              id: 'env-1',
              name: 'Sunny Acres',
            },
          },
        ],
      }),
    );

    await handleDiscordRoutingCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'message-1',
        user: { id: 'discord-user-1', username: 'matt' },
        data: { custom_id: 'discord:route:abcdefghijkl:0' },
      },
      interactionDeferred: true,
      callback: { pendingRouteId: 'abcdefghijkl', selection: 0 },
    });

    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({ channelId: 'channel-1' }),
      }),
    );
    // The card is where the acknowledgement was going, so the launch turns it
    // into one rather than posting a second, identical message beneath it.
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        replaceMessage: expect.objectContaining({
          channel: expect.objectContaining({ channelId: 'message-1' }),
        }),
      }),
    );
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('keeps the launch acknowledgement when the card stayed in the channel', async () => {
    mocks.redisGetdel.mockResolvedValue(
      JSON.stringify({
        requesterDiscordUserId: 'discord-user-1',
        launchOwnerUserId: 'user-1',
        queuedMessage: {
          provider: 'discord',
          text: 'Fix matchmaking',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-1',
        },
        metadata: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'message-1',
        },
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType: 0,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
        options: [
          {
            label: 'Sunny Acres',
            workspace: {
              type: 'environment',
              id: 'env-1',
              name: 'Sunny Acres',
            },
          },
        ],
      }),
    );

    await handleDiscordRoutingCallback({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'channel-1',
        user: { id: 'discord-user-1', username: 'matt' },
        data: { custom_id: 'discord:route:abcdefghijkl:0' },
      },
      interactionDeferred: true,
      callback: { pendingRouteId: 'abcdefghijkl', selection: 0 },
    });

    expect(mocks.launchTask.mock.lastCall?.[0]?.replaceMessage).toBeUndefined();
    expect(mocks.reply.mock.lastCall?.[0]?.text).toContain(
      'Continue in the new task thread',
    );
  });
});
