import { db, eq, runFactory, taskFactory, tasks } from '@roomote/db/server';
import { TaskPayloadKind, type StandardTask } from '@roomote/types';

const {
  createDiscordProviderMock,
  createTelegramProviderMock,
  editDiscordChannelMock,
  editTelegramForumTopicMock,
} = vi.hoisted(() => ({
  createDiscordProviderMock: vi.fn(),
  createTelegramProviderMock: vi.fn(),
  editDiscordChannelMock: vi.fn(),
  editTelegramForumTopicMock: vi.fn(),
}));

vi.mock('../discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    createDiscordProviderMock,
}));

vi.mock('../telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    createTelegramProviderMock,
}));

import { syncTaskCommunicationThreadTitleBestEffort } from '../task-thread-title-sync';

async function seedTaskRun(
  taskId: string,
  payload: Partial<StandardTask['payload']>,
  title = 'Canonical title',
): Promise<void> {
  await taskFactory.create({
    id: taskId,
    modelProvider: 'roomote',
    model: 'test-model',
    title,
    workflow: 'standard',
    surface: 'web',
    trigger: 'manual',
  });

  await runFactory.create({
    payloadKind: TaskPayloadKind.StandardTask,
    payload: {
      repo: 'test/repo',
      description: 'Test task',
      ...payload,
    },
    taskId,
  });
}

describe('syncTaskCommunicationThreadTitleBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createDiscordProviderMock.mockResolvedValue({
      editChannel: editDiscordChannelMock,
    });
    createTelegramProviderMock.mockResolvedValue({
      editForumTopic: editTelegramForumTopicMock,
    });
    editDiscordChannelMock.mockResolvedValue({});
    editTelegramForumTopicMock.mockResolvedValue(undefined);
  });

  it('renames a task-owned Discord thread', async () => {
    await seedTaskRun(
      'task-title-sync-discord',
      {
        communicationProvider: 'discord',
        communicationChannelId: 'discord-parent',
        communicationThreadId: 'discord-thread',
        discordTaskThread: true,
      },
      'Fix <@123> uploads\nImage: screenshot.png',
    );

    await syncTaskCommunicationThreadTitleBestEffort({
      taskId: 'task-title-sync-discord',
    });

    expect(editDiscordChannelMock).toHaveBeenCalledWith({
      channelId: 'discord-thread',
      name: 'Fix uploads',
    });
  });

  it('renames a task-owned Telegram topic', async () => {
    await seedTaskRun(
      'task-title-sync-telegram',
      {
        communicationProvider: 'telegram',
        communicationChannelId: 'telegram-chat',
        communicationThreadId: '42',
        telegramTaskTopic: true,
      },
      'Investigate the failing deployment',
    );

    await syncTaskCommunicationThreadTitleBestEffort({
      taskId: 'task-title-sync-telegram',
    });

    expect(editTelegramForumTopicMock).toHaveBeenCalledWith({
      channelId: 'telegram-chat',
      threadId: '42',
      name: 'Investigate the failing deployment',
    });
  });

  it('does not rename a provider conversation Roomote did not create', async () => {
    await seedTaskRun('task-title-sync-unowned', {
      communicationProvider: 'discord',
      communicationChannelId: 'discord-channel',
      communicationThreadId: 'existing-thread',
    });

    await syncTaskCommunicationThreadTitleBestEffort({
      taskId: 'task-title-sync-unowned',
    });

    expect(createDiscordProviderMock).not.toHaveBeenCalled();
    expect(editDiscordChannelMock).not.toHaveBeenCalled();
  });

  it('deduplicates a task thread preserved across resumed runs', async () => {
    const taskId = 'task-title-sync-deduped';
    const payload: StandardTask['payload'] = {
      repo: 'test/repo',
      description: 'Test task',
      communicationProvider: 'discord' as const,
      communicationChannelId: 'discord-parent',
      communicationThreadId: 'discord-thread',
      discordTaskThread: true,
    };

    await seedTaskRun(taskId, payload);
    await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      payload,
      taskId,
    });

    await syncTaskCommunicationThreadTitleBestEffort({
      taskId,
    });

    expect(editDiscordChannelMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the database title successful when a provider rename fails', async () => {
    await seedTaskRun('task-title-sync-provider-error', {
      communicationProvider: 'discord',
      communicationChannelId: 'discord-parent',
      communicationThreadId: 'discord-thread',
      discordTaskThread: true,
    });
    editDiscordChannelMock.mockRejectedValueOnce(
      new Error('Discord is temporarily unavailable'),
    );

    await expect(
      syncTaskCommunicationThreadTitleBestEffort({
        taskId: 'task-title-sync-provider-error',
      }),
    ).resolves.toBeUndefined();
  });

  it('reconciles a newer canonical title that is saved during the provider call', async () => {
    const taskId = 'task-title-sync-concurrent-edit';
    await seedTaskRun(taskId, {
      communicationProvider: 'discord',
      communicationChannelId: 'discord-parent',
      communicationThreadId: 'discord-thread',
      discordTaskThread: true,
    });
    editDiscordChannelMock.mockImplementationOnce(async () => {
      await db
        .update(tasks)
        .set({ title: 'Newer manual title' })
        .where(eq(tasks.id, taskId));
    });

    await syncTaskCommunicationThreadTitleBestEffort({ taskId });

    expect(editDiscordChannelMock).toHaveBeenNthCalledWith(1, {
      channelId: 'discord-thread',
      name: 'Canonical title',
    });
    expect(editDiscordChannelMock).toHaveBeenNthCalledWith(2, {
      channelId: 'discord-thread',
      name: 'Newer manual title',
    });
  });
});
