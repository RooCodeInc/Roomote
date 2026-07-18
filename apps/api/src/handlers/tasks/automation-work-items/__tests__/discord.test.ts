import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  completeTaskThreadMock,
  findAutomationDestinationMock,
  findDefaultDestinationMock,
  postMessageMock,
  redisGetMock,
  redisSetMock,
  reserveTaskThreadMock,
  resolveProviderMock,
  selectDiscordForumTagMock,
  selectLimitMock,
} = vi.hoisted(() => ({
  completeTaskThreadMock: vi.fn(),
  findAutomationDestinationMock: vi.fn(),
  findDefaultDestinationMock: vi.fn(),
  postMessageMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  reserveTaskThreadMock: vi.fn(),
  resolveProviderMock: vi.fn(),
  selectDiscordForumTagMock: vi.fn(),
  selectLimitMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  selectDiscordForumTag: selectDiscordForumTagMock,
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
  findDiscordAutomationDestination: findAutomationDestinationMock,
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

import { DiscordApiError } from '@roomote/communication/discord-provider';

import {
  createAutomationDiscordTaskThread,
  DiscordAutomationTargetPreparationError,
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
    selectDiscordForumTagMock.mockResolvedValue({
      tagId: 'tag-bug',
      reasoning: 'The work item describes a defect.',
    });
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

  it("prefers the automation's own Discord channel target over the default", async () => {
    findAutomationDestinationMock.mockResolvedValue({
      installationId: 'installation-1',
      guildId: 'guild-1',
      guildName: 'Roomote',
      channelId: 'channel-sentry',
      channelName: 'sentry-triage',
      channelType: 0,
    });

    await expect(
      resolveAutomationDiscordTarget('sentry_triage'),
    ).resolves.toMatchObject({
      provider: 'discord',
      channelId: 'channel-sentry',
    });
    expect(findAutomationDestinationMock).toHaveBeenCalledWith('sentry_triage');
    expect(findDefaultDestinationMock).not.toHaveBeenCalled();
  });

  it('falls back to the default destination when the automation has no Discord target', async () => {
    findAutomationDestinationMock.mockResolvedValue(null);

    await expect(
      resolveAutomationDiscordTarget('sentry_triage'),
    ).resolves.toMatchObject({
      provider: 'discord',
      channelId: 'channel-1',
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
      selectForumTag: expect.any(Function),
    });
    const selectForumTag = reserveTaskThreadMock.mock.calls[0]?.[0]
      .selectForumTag as (tags: unknown[]) => Promise<string | null>;
    await expect(
      selectForumTag([
        {
          id: 'tag-bug',
          name: 'Bug',
          moderated: false,
          emojiId: null,
          emojiName: null,
        },
      ]),
    ).resolves.toBe('tag-bug');
    expect(selectDiscordForumTagMock).toHaveBeenCalledWith({
      taskDescription: 'Fix the flaky test\n\nInvestigate and fix it.',
      availableTags: [expect.objectContaining({ id: 'tag-bug' })],
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

  it('classifies transient Discord failures as retryable target preparation', async () => {
    const target = (await resolveAutomationDiscordTarget())!;
    const workItem = {
      id: 'work-transient',
      title: 'Fix the flaky test',
      brief: null,
      category: null,
      priority: null,
    } as never;
    reserveTaskThreadMock.mockRejectedValueOnce(
      new DiscordApiError({
        method: 'POST',
        path: '/channels/channel-1/threads',
        status: 503,
        message: 'Service unavailable',
      }),
    );

    await expect(
      createAutomationDiscordTaskThread({ target, workItem }),
    ).rejects.toBeInstanceOf(DiscordAutomationTargetPreparationError);
  });

  it('keeps permanent Discord failures terminal', async () => {
    const target = (await resolveAutomationDiscordTarget())!;
    const workItem = {
      id: 'work-permanent',
      title: 'Fix the flaky test',
      brief: null,
      category: null,
      priority: null,
    } as never;
    const forbidden = new DiscordApiError({
      method: 'POST',
      path: '/channels/channel-1/threads',
      status: 403,
      message: 'Missing permissions',
    });
    reserveTaskThreadMock.mockRejectedValueOnce(forbidden);

    await expect(
      createAutomationDiscordTaskThread({ target, workItem }),
    ).rejects.toBe(forbidden);
  });
});
