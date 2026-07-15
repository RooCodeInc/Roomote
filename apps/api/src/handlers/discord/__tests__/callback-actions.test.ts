const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  stopTaskRun: vi.fn(),
  reply: vi.fn(),
  findMappedUser: vi.fn(),
  claimSuggestion: vi.fn(),
  startNewTask: vi.fn(),
  resolveChannel: vi.fn(),
  finalizeWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
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
vi.mock('../setup-suggestions.js', () => ({
  claimDiscordSuggestionLaunch: mocks.claimSuggestion,
}));
vi.mock('../task-orchestration.js', () => ({
  startNewDiscordTask: mocks.startNewTask,
}));
vi.mock('../task-launch.js', () => ({
  resolveDiscordChannelContext: mocks.resolveChannel,
  discordMetadataForChannel: vi.fn(),
}));
vi.mock('../../tasks/orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: vi.fn(),
}));

import { handleDiscordComponentInteraction } from '../callback-actions.js';

describe('Discord component callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reply.mockResolvedValue({ messageId: 'response-1' });
    mocks.findMappedUser.mockResolvedValue('user-1');
  });

  it('cancels an active run only when it belongs to the interaction channel', async () => {
    const run = {
      id: 17,
      taskId: 'task-17',
      status: 'running',
      sandboxServerUrl: null,
      actingUserId: 'user-1',
      task: { initiatorUserId: 'owner-user' },
    };
    mocks.findRun.mockResolvedValue(run);
    mocks.stopTaskRun.mockResolvedValue({ success: true, statusCode: 200 });
    const provider = {} as never;
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
      provider,
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
      cancelledBy: { name: 'Matt', source: 'discord' },
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
      expect.objectContaining({ channel: dmChannel }),
    );
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
});
