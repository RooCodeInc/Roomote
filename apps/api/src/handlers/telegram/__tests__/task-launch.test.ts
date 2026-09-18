import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  consumeTelegramImplicitTopicMock,
  createTelegramForumTopicBestEffortMock,
  editTelegramForumTopicBestEffortMock,
  enqueueTaskMock,
  getTaskUrlMock,
  postTelegramMessageBestEffortMock,
  rememberTelegramImplicitTopicMock,
} = vi.hoisted(() => ({
  consumeTelegramImplicitTopicMock: vi.fn(),
  createTelegramForumTopicBestEffortMock: vi.fn(),
  editTelegramForumTopicBestEffortMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  getTaskUrlMock: vi.fn(),
  postTelegramMessageBestEffortMock: vi.fn(),
  rememberTelegramImplicitTopicMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: enqueueTaskMock,
  getTaskUrl: getTaskUrlMock,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { environments: { findFirst: vi.fn() } } },
  environments: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('../replies.js', () => ({
  createTelegramForumTopicBestEffort: createTelegramForumTopicBestEffortMock,
  editTelegramForumTopicBestEffort: editTelegramForumTopicBestEffortMock,
  postTelegramMessageBestEffort: postTelegramMessageBestEffortMock,
}));

vi.mock('../webhook-gate.js', () => ({
  consumeTelegramImplicitTopic: consumeTelegramImplicitTopicMock,
  rememberTelegramImplicitTopic: rememberTelegramImplicitTopicMock,
}));

import {
  buildTelegramTaskTopicName,
  launchTelegramTask,
  shouldCreateTelegramTaskTopic,
} from '../task-launch';

describe('Telegram task topic launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueTaskMock.mockResolvedValue({ id: 'run-1', taskId: 'task-1' });
    getTaskUrlMock.mockReturnValue('https://roomote.example.test/tasks/task-1');
    postTelegramMessageBestEffortMock.mockResolvedValue({ messageId: '900' });
    consumeTelegramImplicitTopicMock.mockResolvedValue(false);
    editTelegramForumTopicBestEffortMock.mockResolvedValue(true);
    rememberTelegramImplicitTopicMock.mockResolvedValue(undefined);
  });

  it('stamps the owning Fast Session onto the task and runs the kickoff gate', async () => {
    const beforeEnqueue = vi.fn().mockResolvedValue(undefined);
    enqueueTaskMock.mockImplementation(
      async (
        _input: unknown,
        options: {
          beforeEnqueue?: (taskRun: {
            id: number;
            taskId: string;
          }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue?.({ id: 7, taskId: 'task-1' });
        return { id: 7, taskId: 'task-1' };
      },
    );

    await launchTelegramTask({
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'telegram',
        text: 'Fix the flaky test',
        user: 'Matt',
        userId: 'user-1',
        ts: '100',
        channel: '555',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '555',
        communicationMessageId: '100',
      },
      workspace: { repoForPayload: 'acme/app', workspaceDisplayName: 'App' },
      fastAgentParent: {
        sessionId: '66666666-6666-4666-8666-666666666666',
        conversation: {
          surface: 'telegram',
          workspaceId: '555',
          conversationId: '555:user:user-1',
          replyTarget: { channelId: '555' },
        },
      },
      beforeEnqueue,
    });

    expect(beforeEnqueue).toHaveBeenCalledWith({ id: 7, taskId: 'task-1' });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            reportConsumer: 'orchestrator',
            fastAgentSessionId: '66666666-6666-4666-8666-666666666666',
            fastAgentParent: expect.objectContaining({
              sessionId: '66666666-6666-4666-8666-666666666666',
            }),
          }),
        }),
      }),
      expect.objectContaining({ beforeEnqueue }),
    );
  });

  it('uses a newly created topic as the task conversation', async () => {
    createTelegramForumTopicBestEffortMock.mockResolvedValue({
      threadId: '77',
    });

    await launchTelegramTask({
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'telegram',
        user: 'Grace',
        userId: 'user-1',
        text: 'Fix the flaky login test',
        ts: '42',
        channel: '111000111',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '-100111000111',
        communicationMessageId: '42',
      },
      workspace: {
        repoForPayload: 'roomote/roomote',
        workspaceDisplayName: 'Roomote',
      },
      createTopicForTask: true,
    });

    expect(createTelegramForumTopicBestEffortMock).toHaveBeenCalledWith({
      chatId: '-100111000111',
      name: 'Fix the flaky login test',
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'telegram',
            communicationChannelId: '-100111000111',
            communicationThreadId: '77',
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
    const enqueuedPayload = enqueueTaskMock.mock.calls[0]?.[0].task.payload;
    expect(enqueuedPayload.communicationMessageId).toBe('900');
    expect(postTelegramMessageBestEffortMock).toHaveBeenNthCalledWith(1, {
      chatId: '-100111000111',
      threadId: '77',
      text: 'Task request from Grace:\n\nFix the flaky login test',
    });
    expect(postTelegramMessageBestEffortMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: '-100111000111',
        threadId: '77',
        replyToMessageId: '900',
      }),
    );
    expect(postTelegramMessageBestEffortMock).toHaveBeenNthCalledWith(3, {
      chatId: '-100111000111',
      threadId: undefined,
      replyToMessageId: '42',
      text: 'Started “Fix the flaky login test” in a new topic.',
      buttons: [
        [
          {
            text: 'Open topic',
            url: 'https://t.me/c/111000111/77/900',
          },
          {
            text: 'Follow Task',
            url: 'https://roomote.example.test/tasks/task-1',
          },
        ],
      ],
    });

    const onEarlyTitleGenerated = enqueueTaskMock.mock.calls[0]?.[1]
      .onEarlyTitleGenerated as (input: {
      title: string;
      taskRun: { taskId: string };
    }) => Promise<void>;
    await onEarlyTitleGenerated({
      title: 'Fix flaky login tests',
      taskRun: { taskId: 'task-1' },
    });
    expect(editTelegramForumTopicBestEffortMock).toHaveBeenCalledWith({
      chatId: '-100111000111',
      threadId: '77',
      name: 'Fix flaky login tests',
    });
  });

  it('names the new topic in private chats where Telegram cannot deep-link it', async () => {
    createTelegramForumTopicBestEffortMock.mockResolvedValue({
      threadId: '77',
    });

    await launchTelegramTask({
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'telegram',
        user: 'Grace',
        userId: 'user-1',
        text: 'Fix the flaky login test',
        ts: '42',
        channel: '111000111',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '111000111',
        communicationMessageId: '42',
      },
      workspace: {
        repoForPayload: 'roomote/roomote',
        workspaceDisplayName: 'Roomote',
      },
      createTopicForTask: true,
    });

    expect(postTelegramMessageBestEffortMock).toHaveBeenNthCalledWith(3, {
      chatId: '111000111',
      threadId: undefined,
      replyToMessageId: '42',
      text: "Started “Fix the flaky login test” in a new topic. Open it from Telegram's topic list.",
      buttons: [
        [
          {
            text: 'Follow Task',
            url: 'https://roomote.example.test/tasks/task-1',
          },
        ],
      ],
    });
  });

  it('falls back to the source chat when topic creation is unavailable', async () => {
    createTelegramForumTopicBestEffortMock.mockResolvedValue(null);

    await launchTelegramTask({
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'telegram',
        user: 'Grace',
        userId: 'user-1',
        text: 'Fix the flaky login test',
        ts: '42',
        channel: '111000111',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '111000111',
        communicationMessageId: '42',
      },
      workspace: {
        repoForPayload: 'roomote/roomote',
        workspaceDisplayName: 'Roomote',
      },
      createTopicForTask: true,
    });

    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationMessageId: '42',
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '111000111',
        replyToMessageId: '42',
        text: "Started a task in Roomote here because I couldn't create a new Telegram topic. If this keeps happening, check Threaded Mode or the bot's Manage Topics permission.",
      }),
    );
  });

  it('renames only existing topics that Telegram marked as implicit', async () => {
    consumeTelegramImplicitTopicMock.mockResolvedValue(true);

    await launchTelegramTask({
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'telegram',
        user: 'Grace',
        userId: 'user-1',
        text: 'Fix the flaky login test',
        ts: '42',
        channel: '111000111',
        threadTs: '77',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '111000111',
        communicationThreadId: '77',
        communicationMessageId: '42',
      },
      workspace: {
        repoForPayload: 'roomote/roomote',
        workspaceDisplayName: 'Roomote',
      },
    });

    const onEarlyTitleGenerated = enqueueTaskMock.mock.calls[0]?.[1]
      .onEarlyTitleGenerated as (input: {
      title: string;
      taskRun: { taskId: string };
    }) => Promise<void>;
    await onEarlyTitleGenerated({
      title: 'Fix flaky login tests',
      taskRun: { taskId: 'task-1' },
    });

    expect(consumeTelegramImplicitTopicMock).toHaveBeenCalledWith({
      chatId: '111000111',
      threadId: '77',
    });
    expect(editTelegramForumTopicBestEffortMock).toHaveBeenCalledWith({
      chatId: '111000111',
      threadId: '77',
      name: 'Fix flaky login tests',
    });
  });

  it('throws when an implicit topic rename fails so early-title checkpoint stays open', async () => {
    consumeTelegramImplicitTopicMock.mockResolvedValue(true);
    editTelegramForumTopicBestEffortMock.mockResolvedValue(false);

    await launchTelegramTask({
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'telegram',
        user: 'Grace',
        userId: 'user-1',
        text: 'Fix the flaky login test',
        ts: '42',
        channel: '111000111',
        threadTs: '77',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '111000111',
        communicationThreadId: '77',
        communicationMessageId: '42',
      },
      workspace: {
        repoForPayload: 'roomote/roomote',
        workspaceDisplayName: 'Roomote',
      },
    });

    const onEarlyTitleGenerated = enqueueTaskMock.mock.calls[0]?.[1]
      .onEarlyTitleGenerated as (input: {
      title: string;
      taskRun: { taskId: string };
    }) => Promise<void>;

    await expect(
      onEarlyTitleGenerated({
        title: 'Fix flaky login tests',
        taskRun: { taskId: 'task-1' },
      }),
    ).rejects.toThrow(/Failed to rename Telegram topic/);
    expect(rememberTelegramImplicitTopicMock).toHaveBeenCalledWith({
      chatId: '111000111',
      threadId: '77',
    });
  });

  it('creates topics only for eligible new task conversations', () => {
    expect(
      shouldCreateTelegramTaskTopic({
        chatType: 'private',
        privateTopicsEnabled: true,
      }),
    ).toBe(true);
    expect(shouldCreateTelegramTaskTopic({ chatType: 'private' })).toBe(false);
    expect(
      shouldCreateTelegramTaskTopic({
        chatType: 'supergroup',
        isForum: true,
      }),
    ).toBe(true);
    expect(
      shouldCreateTelegramTaskTopic({
        chatType: 'private',
        threadId: '77',
        privateTopicsEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateTelegramTaskTopic({
        chatType: 'private',
        threadId: '77',
        forceNewTopic: true,
        privateTopicsEnabled: true,
      }),
    ).toBe(true);
    expect(shouldCreateTelegramTaskTopic({ chatType: 'group' })).toBe(false);
  });

  it('normalizes and truncates task topic names', () => {
    expect(buildTelegramTaskTopicName('  Fix\n\nlogin   tests  ')).toBe(
      'Fix login tests',
    );
    expect(buildTelegramTaskTopicName('x'.repeat(200))).toHaveLength(96);
    expect(buildTelegramTaskTopicName('   ')).toBe('Roomote task');
  });
});
