import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  completeTaskThreadMock,
  findDefaultDestinationMock,
  postMessageMock,
  redisGetMock,
  redisSetMock,
  reserveTaskThreadMock,
  resolveProviderMock,
  selectLimitMock,
} = vi.hoisted(() => ({
  completeTaskThreadMock: vi.fn(),
  findDefaultDestinationMock: vi.fn(),
  postMessageMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  reserveTaskThreadMock: vi.fn(),
  resolveProviderMock: vi.fn(),
  selectLimitMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: redisGetMock,
    set: redisSetMock,
  }),
}));

vi.mock('@roomote/db/server', () => ({
  slackInstallations: { id: 'id', isActive: 'isActive' },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  findDiscordDefaultDestination: findDefaultDestinationMock,
}));

vi.mock('../../../discord/provider.js', () => ({
  resolveDiscordProvider: resolveProviderMock,
}));

vi.mock('../../../slack/helpers/suggestion-workspace.js', () => ({
  buildSuggestionBadgePrefix: vi.fn(() => ''),
}));

vi.mock('../../communication-task-thread.js', () => ({
  buildCommunicationTaskThreadName: vi.fn((title: string) => title),
}));

import {
  createAutomationDiscordTaskThread,
  postLateBoundWorkItemFailureToDiscord,
  resolveAutomationDiscordTarget,
} from '../discord';

describe('Discord automation work-item delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimitMock.mockResolvedValue([]);
    findDefaultDestinationMock.mockResolvedValue({
      installationId: 'installation-1',
      guildId: 'guild-1',
      guildName: 'Roomote',
      channelId: 'channel-1',
      channelName: 'automations',
      channelType: 0,
    });
    resolveProviderMock.mockResolvedValue({
      provider: {
        reserveTaskThread: reserveTaskThreadMock,
        completeTaskThread: completeTaskThreadMock,
        postMessage: postMessageMock,
      },
    });
    const reservedThread = {
      channelId: 'thread-1',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky test',
      kind: 'thread' as const,
    };
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    reserveTaskThreadMock.mockResolvedValue(reservedThread);
    completeTaskThreadMock.mockResolvedValue({
      ...reservedThread,
      messageId: 'message-1',
    });
  });

  it('resolves the selected Discord destination when Slack is absent', async () => {
    await expect(resolveAutomationDiscordTarget()).resolves.toMatchObject({
      provider: 'discord',
      guildId: 'guild-1',
      channelId: 'channel-1',
      channelType: 0,
    });
  });

  it('leaves Slack precedence to the caller when Slack is installed but unusable', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'slack-1' }]);

    await expect(resolveAutomationDiscordTarget()).resolves.toMatchObject({
      provider: 'discord',
      guildId: 'guild-1',
    });
    expect(findDefaultDestinationMock).toHaveBeenCalled();
  });

  it('creates a child task thread and posts failures back into it', async () => {
    const target = (await resolveAutomationDiscordTarget())!;
    const workItem = {
      id: 'work-1',
      title: 'Fix the flaky test',
      brief: 'Investigate and fix it.',
      category: null,
      priority: null,
    } as never;
    const threadedTarget = await createAutomationDiscordTaskThread({
      target,
      workItem,
    });

    expect(reserveTaskThreadMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      name: 'Fix the flaky test',
      initialText: '**Fix the flaky test**\nInvestigate and fix it.',
    });
    expect(completeTaskThreadMock).toHaveBeenCalledWith({
      thread: {
        channelId: 'thread-1',
        parentChannelId: 'channel-1',
        name: 'Fix the flaky test',
        kind: 'thread',
      },
      initialText: '**Fix the flaky test**\nInvestigate and fix it.',
    });
    expect(redisSetMock).toHaveBeenNthCalledWith(
      1,
      'discord:automation_task_thread:work-1',
      JSON.stringify({
        channelId: 'thread-1',
        parentChannelId: 'channel-1',
        name: 'Fix the flaky test',
        kind: 'thread',
      }),
      'EX',
      2_592_000,
    );
    expect(threadedTarget).toMatchObject({
      threadId: 'thread-1',
      messageId: 'message-1',
    });

    await postLateBoundWorkItemFailureToDiscord({
      target: threadedTarget,
      workItem,
      reason: 'No environment was available.',
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-1',
      }),
    );
  });

  it('reuses the work-item reservation when starter delivery is retried', async () => {
    const target = (await resolveAutomationDiscordTarget())!;
    const workItem = {
      id: 'work-retry',
      title: 'Fix the flaky test',
      brief: 'Investigate and fix it.',
      category: null,
      priority: null,
    } as never;
    const reservedThread = {
      channelId: 'thread-reserved',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky test',
      kind: 'thread' as const,
    };
    const completedThread = {
      ...reservedThread,
      messageId: 'message-resumed',
    };
    reserveTaskThreadMock.mockResolvedValueOnce(reservedThread);
    completeTaskThreadMock
      .mockRejectedValueOnce(new Error('starter unavailable'))
      .mockResolvedValueOnce(completedThread);

    await expect(
      createAutomationDiscordTaskThread({ target, workItem }),
    ).rejects.toThrow('starter unavailable');
    expect(redisSetMock).toHaveBeenNthCalledWith(
      1,
      'discord:automation_task_thread:work-retry',
      JSON.stringify(reservedThread),
      'EX',
      2_592_000,
    );

    redisGetMock.mockResolvedValue(JSON.stringify(reservedThread));
    await expect(
      createAutomationDiscordTaskThread({ target, workItem }),
    ).resolves.toMatchObject({
      threadId: 'thread-reserved',
      messageId: 'message-resumed',
    });

    expect(reserveTaskThreadMock).toHaveBeenCalledTimes(1);
    expect(completeTaskThreadMock).toHaveBeenCalledTimes(2);
    expect(redisSetMock).toHaveBeenNthCalledWith(
      2,
      'discord:automation_task_thread:work-retry',
      JSON.stringify(completedThread),
      'EX',
      2_592_000,
    );
  });
});
