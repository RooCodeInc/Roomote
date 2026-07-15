const mocks = vi.hoisted(() => ({
  buildRoutingContext: vi.fn(),
  findSourceRun: vi.fn(),
  getTaskUrl: vi.fn(),
  reply: vi.fn(),
  routeTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildDiscordRoutingContext: mocks.buildRoutingContext,
  getTaskUrl: mocks.getTaskUrl,
  routeTask: mocks.routeTask,
}));

vi.mock('@roomote/sdk/server', () => ({
  findDiscordInstallationByGuildId: vi.fn(),
}));

vi.mock('../../tasks/communication-task-run-lookup.js', () => ({
  findCommunicationTaskRunBySourceEvent: mocks.findSourceRun,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

import { startNewDiscordTask } from '../task-orchestration.js';

describe('startNewDiscordTask idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/task/task-1');
    mocks.reply.mockResolvedValue({ messageId: 'reply-1' });
  });

  it('does not route or launch a second task for a retried source event', async () => {
    mocks.findSourceRun.mockResolvedValue({
      id: 41,
      taskId: 'task-1',
      status: 'running',
      payload: {
        communicationProvider: 'discord',
        communicationSourceEventId: 'message-1',
      },
    });

    const result = await startNewDiscordTask({
      provider: {} as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky test',
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
    });

    expect(result.status).toBe('already_started');
    expect(mocks.buildRoutingContext).not.toHaveBeenCalled();
    expect(mocks.routeTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already started'),
      }),
    );
  });
});
