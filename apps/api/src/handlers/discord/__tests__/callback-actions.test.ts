const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  stopTaskRun: vi.fn(),
  reply: vi.fn(),
  findMappedUser: vi.fn(),
  findSuggestionByMessage: vi.fn(),
  claimSuggestionByMessage: vi.fn(),
  claimSuggestion: vi.fn(),
  startNewTask: vi.fn(),
  resolveChannel: vi.fn(),
  resolveWorkspace: vi.fn(),
  finalizeWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  handlePrReviewAction: vi.fn(),
  processFastAgentMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  activeRunStatuses: [],
  and: (...values: unknown[]) => values,
  or: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
  isNull: (value: unknown) => value,
  sql: () => 'sql',
  taskRuns: {
    id: 'id',
    payload: 'payload',
    status: 'status',
    canceledAt: 'canceledAt',
  },
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  finalizeWorkItemLaunched: mocks.finalizeWorkItem,
  releaseWorkItemClaim: mocks.releaseWorkItem,
}));

vi.mock('../../tasks/task-stop.js', () => ({ stopTaskRun: mocks.stopTaskRun }));
vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));
vi.mock('../routing-confirmation.js', () => ({
  parseDiscordRouteCallbackData: () => null,
  handleDiscordRoutingCallback: vi.fn(),
}));
vi.mock('@roomote/sdk/server', () => ({
  findDiscordMappedUserId: mocks.findMappedUser,
}));
vi.mock('../../fast-agent-entry.js', () => ({
  resolveFastAgentEntryMode: ({
    userDefaultEnabled,
    fastAvailable,
  }: {
    userDefaultEnabled: boolean;
    fastAvailable?: boolean;
  }) => (userDefaultEnabled && fastAvailable !== false ? 'default' : null),
}));
vi.mock('../setup-suggestions.js', () => ({
  claimDiscordSuggestionLaunch: mocks.claimSuggestion,
}));
vi.mock('../task-orchestration.js', () => ({
  startNewDiscordTask: mocks.startNewTask,
}));
vi.mock('../fast-agent.js', () => ({
  getDiscordFastConversationId: vi.fn(
    (channel: { channelId: string }, eventId: string) =>
      channel.channelId || eventId,
  ),
  startDiscordFastAgentResponse: mocks.processFastAgentMessage,
}));
vi.mock('../task-launch.js', () => ({
  resolveDiscordChannelContext: mocks.resolveChannel,
  resolveDiscordWorkspace: mocks.resolveWorkspace,
  discordMetadataForChannel: vi.fn(),
}));
vi.mock('../../tasks/orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: vi.fn(),
}));
vi.mock('../../tasks/current-thread-suggestion-reaction.js', () => ({
  findCurrentThreadSuggestionIdByMessage: mocks.findSuggestionByMessage,
  claimCurrentThreadSuggestionByMessage: mocks.claimSuggestionByMessage,
}));
vi.mock('../pr-review-action.js', () => ({
  handleDiscordPrReviewActionCallback: mocks.handlePrReviewAction,
}));

import {
  handleDiscordComponentInteraction,
  handleDiscordSuggestionReaction,
} from '../callback-actions.js';

describe('Discord component callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reply.mockResolvedValue({ messageId: 'response-1' });
    mocks.findMappedUser.mockResolvedValue('user-1');
    mocks.findSuggestionByMessage.mockResolvedValue('suggestion-1');
    mocks.processFastAgentMessage.mockResolvedValue({ accepted: true });
    mocks.releaseWorkItem.mockResolvedValue(true);
    mocks.resolveWorkspace.mockResolvedValue({
      environmentId: 'env-1',
      repoForPayload: 'acme/app',
      workspaceDisplayName: 'App',
    });
  });

  it('routes PR review callback payloads to the persisted action handler', async () => {
    const provider = {} as never;
    const interaction = {
      id: 'interaction-1',
      application_id: 'app-1',
      type: 3,
      token: 'token-1',
      channel_id: 'thread-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: { custom_id: 'prr:a:nonce-1234', component_type: 2 },
    };
    const channel = {
      channelId: 'thread-1',
      channelName: 'Fix tests',
      channelType: 11,
      guildId: 'guild-1',
      parentChannelId: 'channel-1',
      isDirectMessage: false,
      isThread: true,
    };

    await expect(
      handleDiscordComponentInteraction({
        provider,
        applicationId: 'app-1',
        interaction,
        interactionDeferred: true,
        channel,
      }),
    ).resolves.toBe('handled');

    expect(mocks.handlePrReviewAction).toHaveBeenCalledWith({
      provider,
      applicationId: 'app-1',
      interaction,
      interactionDeferred: true,
      channel,
      choice: 'auto',
      nonce: 'nonce-1234',
    });
  });

  it('does not claim a reaction suggestion when account mapping fails', async () => {
    mocks.findMappedUser.mockRejectedValue(new Error('database unavailable'));
    const postMessage = vi.fn();

    await expect(
      handleDiscordSuggestionReaction({
        provider: { postMessage } as never,
        applicationId: 'app-1',
        channel: {
          channelId: 'thread-1',
          channelName: 'Suggested tasks',
          channelType: 11,
          guildId: 'guild-1',
          parentChannelId: 'channel-1',
          isDirectMessage: false,
          isThread: true,
        },
        channelId: 'thread-1',
        messageId: 'suggestion-message-1',
        eventId: 'reaction-1',
        sender: { id: 'discord-user-1', username: 'matt' },
      }),
    ).rejects.toThrow('database unavailable');
    expect(mocks.claimSuggestionByMessage).not.toHaveBeenCalled();
  });

  it('starts a Fast session for a router-backed suggestion when Fast is the default', async () => {
    mocks.claimSuggestionByMessage.mockResolvedValue({
      outcome: 'claimed',
      suggestion: {
        id: 'suggestion-1',
        title: 'Fix tests',
        brief: 'Repair the flaky suite.',
        investigationContext: null,
        targetRepositoryFullName: null,
        targetEnvironmentId: null,
        usesRouterLaunch: true,
        launchClaimedAt: new Date('2026-08-28T00:00:00.000Z'),
      },
    });
    mocks.resolveChannel.mockResolvedValue({
      channelId: 'channel-1',
      channelName: 'general',
      channelType: 0,
      guildId: 'guild-1',
      isDirectMessage: false,
      isThread: false,
    });
    mocks.finalizeWorkItem.mockResolvedValue({ id: 'suggestion-1' });
    const postMessage = vi.fn();

    await handleDiscordSuggestionReaction({
      provider: { postMessage } as never,
      applicationId: 'app-1',
      channel: {
        channelId: 'thread-1',
        channelName: 'Suggested tasks',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      channelId: 'thread-1',
      messageId: 'suggestion-message-1',
      eventId: 'reaction-1',
      sender: { id: 'discord-user-1', username: 'matt' },
    });

    expect(mocks.processFastAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'reaction-1',
        senderUserId: 'user-1',
        channel: expect.objectContaining({ channelId: 'thread-1' }),
        question: expect.stringContaining(
          'Start this suggested task: Fix tests',
        ),
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.finalizeWorkItem).toHaveBeenCalledWith(expect.anything(), {
      id: 'suggestion-1',
      taskId: null,
      claimedAt: new Date('2026-08-28T00:00:00.000Z'),
    });
  });

  it('starts a coding task for a pinned suggestion', async () => {
    const claimedAt = new Date('2026-08-28T00:00:00.000Z');
    mocks.claimSuggestionByMessage.mockResolvedValue({
      outcome: 'claimed',
      suggestion: {
        id: 'suggestion-1',
        title: 'Fix tests',
        brief: 'Repair the flaky suite.',
        investigationContext: null,
        targetRepositoryFullName: null,
        targetEnvironmentId: null,
        usesRouterLaunch: false,
        launchClaimedAt: claimedAt,
      },
    });
    mocks.resolveChannel.mockResolvedValue({
      channelId: 'channel-1',
      channelName: 'general',
      channelType: 0,
      guildId: 'guild-1',
      isDirectMessage: false,
      isThread: false,
    });
    mocks.startNewTask.mockResolvedValue({
      status: 'started',
      launchResult: { id: 42, taskId: 'task-1' },
      taskUrl: 'https://roomote.example/tasks/task-1',
    });
    mocks.finalizeWorkItem.mockResolvedValue({ id: 'suggestion-1' });
    const postMessage = vi.fn();

    await handleDiscordSuggestionReaction({
      provider: { postMessage } as never,
      applicationId: 'app-1',
      channel: {
        channelId: 'thread-1',
        channelName: 'Suggested tasks',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      channelId: 'thread-1',
      messageId: 'suggestion-message-1',
      eventId: 'reaction-1',
      sender: { id: 'discord-user-1', username: 'matt' },
    });

    expect(mocks.startNewTask).toHaveBeenCalled();
    expect(mocks.processFastAgentMessage).not.toHaveBeenCalled();
    expect(mocks.finalizeWorkItem).toHaveBeenCalledWith(expect.anything(), {
      id: 'suggestion-1',
      taskId: 'task-1',
      claimedAt,
    });
  });

  it('releases the suggestion when the Fast session is busy', async () => {
    const claimedAt = new Date('2026-08-28T00:00:00.000Z');
    mocks.processFastAgentMessage.mockResolvedValue({
      accepted: false,
      reason: 'Fast session is busy.',
    });
    mocks.claimSuggestionByMessage.mockResolvedValue({
      outcome: 'claimed',
      suggestion: {
        id: 'suggestion-1',
        title: 'Fix tests',
        brief: 'Repair the flaky suite.',
        investigationContext: null,
        targetRepositoryFullName: null,
        targetEnvironmentId: null,
        usesRouterLaunch: true,
        launchClaimedAt: claimedAt,
      },
    });
    mocks.resolveChannel.mockResolvedValue({
      channelId: 'channel-1',
      channelName: 'general',
      channelType: 0,
      guildId: 'guild-1',
      isDirectMessage: false,
      isThread: false,
    });
    const postMessage = vi.fn();

    await handleDiscordSuggestionReaction({
      provider: { postMessage } as never,
      applicationId: 'app-1',
      channel: {
        channelId: 'thread-1',
        channelName: 'Suggested tasks',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      channelId: 'thread-1',
      messageId: 'suggestion-message-1',
      eventId: 'reaction-1',
      sender: { id: 'discord-user-1', username: 'matt' },
    });

    expect(mocks.finalizeWorkItem).not.toHaveBeenCalled();
    expect(mocks.releaseWorkItem).toHaveBeenCalledWith(expect.anything(), {
      id: 'suggestion-1',
      claimedAt,
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Could not start'),
      }),
    );
  });

  it('cancels an active run only when it belongs to the interaction channel', async () => {
    const run = {
      id: 17,
      taskId: 'task-17',
      status: 'running',
      sandboxServerUrl: null,
      actingUserId: 'user-1',
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
        discordReactionChannelId: 'channel-1',
        discordReactionMessageId: 'origin-1',
        discordTaskThread: true,
      },
      task: { initiatorUserId: 'owner-user' },
    };
    mocks.findRun.mockResolvedValue(run);
    mocks.stopTaskRun.mockResolvedValue({ success: true, statusCode: 200 });
    const addReaction = vi.fn().mockResolvedValue(undefined);
    const provider = {
      addReaction,
    } as unknown as {
      addReaction: typeof addReaction;
    };
    const interaction = {
      id: 'interaction-1',
      application_id: 'app-1',
      type: 3,
      token: 'token-1',
      channel_id: 'thread-1',
      member: {
        nick: 'Matt',
        user: { id: 'discord-user-1', username: 'matt' },
      },
      data: { custom_id: 'discord:cancel:17', component_type: 2 },
    };

    const result = await handleDiscordComponentInteraction({
      provider: provider as never,
      applicationId: 'app-1',
      interaction,
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Fix tests',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(result).toBe('handled');
    expect(mocks.findRun).toHaveBeenCalled();
    expect(mocks.stopTaskRun).toHaveBeenCalledWith({
      run,
      authUserId: 'user-1',
      allowDirectCancelWithoutSandbox: true,
      terminate: true,
      cancelledBy: { name: 'Matt', source: 'discord' },
    });
    expect(addReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'origin-1',
      name: 'x',
    });
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 'app-1',
        interaction: { interaction, interactionDeferred: true },
        text: 'Canceled the task.',
      }),
    );
  });

  it('lets the task owner cancel after another linked user became the run actor', async () => {
    const run = {
      id: 17,
      taskId: 'task-17',
      status: 'running',
      sandboxServerUrl: null,
      actingUserId: 'current-actor',
      task: { initiatorUserId: 'owner-user' },
    };
    mocks.findRun.mockResolvedValue(run);
    mocks.findMappedUser.mockResolvedValue('owner-user');
    mocks.stopTaskRun.mockResolvedValue({ success: true, statusCode: 200 });

    await handleDiscordComponentInteraction({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'thread-1',
        user: { id: 'discord-owner', username: 'owner' },
        data: { custom_id: 'discord:cancel:17', component_type: 2 },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Fix tests',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(mocks.stopTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ run, authUserId: 'owner-user' }),
    );
  });

  it('refuses a copied cancel button when the linked clicker is not the actor or owner', async () => {
    mocks.findRun.mockResolvedValue({
      id: 17,
      taskId: 'task-17',
      status: 'running',
      sandboxServerUrl: null,
      actingUserId: 'current-actor',
      task: { initiatorUserId: 'owner-user' },
    });
    mocks.findMappedUser.mockResolvedValue('different-user');

    await handleDiscordComponentInteraction({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'thread-1',
        user: { id: 'discord-user-2', username: 'other' },
        data: { custom_id: 'discord:cancel:17', component_type: 2 },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Fix tests',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Only the task owner or current task participant can cancel this task.',
      }),
    );
  });

  it('refuses cancel requests from unlinked Discord users', async () => {
    mocks.findRun.mockResolvedValue({
      id: 17,
      taskId: 'task-17',
      status: 'running',
      sandboxServerUrl: null,
      actingUserId: 'user-1',
      task: { initiatorUserId: 'user-1' },
    });
    mocks.findMappedUser.mockResolvedValue(null);

    await handleDiscordComponentInteraction({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'thread-1',
        user: { id: 'discord-user-unlinked', username: 'unlinked' },
        data: { custom_id: 'discord:cancel:17', component_type: 2 },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'thread-1',
        channelName: 'Fix tests',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Link your Discord account to Roomote before canceling tasks.',
      }),
    );
  });

  it('does not call the task stop endpoint for a stale or foreign button', async () => {
    mocks.findRun.mockResolvedValue(null);

    await handleDiscordComponentInteraction({
      provider: {} as never,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-1',
        application_id: 'app-1',
        type: 3,
        token: 'token-1',
        channel_id: 'other-thread',
        user: { id: 'discord-user-1', username: 'matt' },
        data: { custom_id: 'discord:cancel:17', component_type: 2 },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'other-thread',
        channelName: 'Other',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(mocks.stopTaskRun).not.toHaveBeenCalled();
    expect(mocks.findMappedUser).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'That task is no longer running.' }),
    );
  });

  it('launches a DM-delivered setup suggestion in the DM conversation', async () => {
    const postMessage = vi.fn().mockResolvedValue({ messageId: 'reply-1' });
    const provider = { postMessage } as never;
    mocks.claimSuggestion.mockResolvedValue({
      id: 'suggestion-1',
      title: 'Fix the flaky login test',
      brief: null,
      targetRepositoryFullName: null,
      targetEnvironmentId: 'env-1',
      investigationContext: null,
      launchClaimedAt: new Date(),
    });
    mocks.startNewTask.mockResolvedValue({
      status: 'started',
      launchResult: { id: 42, taskId: 'task-9' },
      taskUrl: 'https://app.example.com/task/task-9',
    });
    mocks.finalizeWorkItem.mockResolvedValue({ id: 'suggestion-1' });

    const dmChannel = {
      channelId: 'dm-1',
      channelName: 'DM',
      channelType: 1,
      isDirectMessage: true,
      isThread: false,
    };

    const result = await handleDiscordComponentInteraction({
      provider,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-2',
        application_id: 'app-1',
        type: 3,
        token: 'token-2',
        channel_id: 'dm-1',
        user: { id: 'discord-user-1', username: 'matt' },
        data: { custom_id: 'idea:suggestion-1', component_type: 2 },
      },
      interactionDeferred: true,
      channel: dmChannel,
    });

    expect(result).toBe('handled');
    // DM cards have no parent channel: the task launches in the DM itself
    // instead of throwing and releasing the claim.
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: dmChannel,
        workspaceOverride: expect.objectContaining({ environmentId: 'env-1' }),
      }),
    );
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      type: 'environment',
      id: 'env-1',
      name: 'env-1',
    });
    expect(mocks.releaseWorkItem).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-1',
        text: 'Started “Fix the flaky login test”.',
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ threadId: expect.anything() }),
    );
  });

  it('posts the canonical read-only message when a suggestion launch is policy-blocked', async () => {
    const postMessage = vi.fn().mockResolvedValue({ messageId: 'reply-1' });
    const provider = { postMessage } as never;
    mocks.claimSuggestion.mockResolvedValue({
      id: 'suggestion-1',
      title: 'Fix the flaky login test',
      brief: null,
      targetRepositoryFullName: null,
      investigationContext: null,
      launchClaimedAt: new Date(),
    });
    mocks.startNewTask.mockRejectedValue({ code: 'deployment_read_only' });

    const result = await handleDiscordComponentInteraction({
      provider,
      applicationId: 'app-1',
      interaction: {
        id: 'interaction-2',
        application_id: 'app-1',
        type: 3,
        token: 'token-2',
        channel_id: 'dm-1',
        user: { id: 'discord-user-1', username: 'matt' },
        data: { custom_id: 'idea:suggestion-1', component_type: 2 },
      },
      interactionDeferred: true,
      channel: {
        channelId: 'dm-1',
        channelName: 'DM',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
    });

    expect(result).toBe('handled');
    expect(mocks.releaseWorkItem).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'New tasks are paused due to a billing issue. Please check billing.',
      }),
    );
  });
});
