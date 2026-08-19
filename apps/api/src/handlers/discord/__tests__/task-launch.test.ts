const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getTaskUrl: vi.fn(),
  selectDiscordForumTag: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  dbSelect: vi.fn(),
  dbFrom: vi.fn(),
  dbSelectWhere: vi.fn(),
  dbLimit: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
  getTaskUrl: mocks.getTaskUrl,
  selectDiscordForumTag: mocks.selectDiscordForumTag,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
  }),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: (...args: unknown[]) => {
      mocks.dbUpdate(...args);
      return {
        set: (...setArgs: unknown[]) => {
          mocks.dbSet(...setArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              mocks.dbWhere(...whereArgs);
              return Promise.resolve();
            },
          };
        },
      };
    },
    select: (...args: unknown[]) => {
      mocks.dbSelect(...args);
      return {
        from: (...fromArgs: unknown[]) => {
          mocks.dbFrom(...fromArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              mocks.dbSelectWhere(...whereArgs);
              return {
                limit: (...limitArgs: unknown[]) => mocks.dbLimit(...limitArgs),
              };
            },
          };
        },
      };
    },
  },
  environments: { id: 'id' },
  taskRuns: { id: 'id', payload: 'payload' },
  tasks: { id: 'id', title: 'title' },
  eq: (...values: unknown[]) => values,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));

import { DiscordApiError } from '@roomote/communication/discord-provider';

import { launchDiscordTask } from '../task-launch.js';

describe('launchDiscordTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.redisDel.mockResolvedValue(1);
    mocks.enqueueTask.mockResolvedValue({ id: 41, taskId: 'task-41' });
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/tasks/task-41');
    mocks.selectDiscordForumTag.mockResolvedValue({
      tagId: 'tag-bug',
      reasoning: 'The request describes a defect.',
    });
    mocks.dbLimit.mockResolvedValue([
      { title: 'Repair flaky authentication tests' },
    ]);
  });

  it('creates a public task thread and renames it with the generated title', async () => {
    const reservedThread = {
      channelId: 'thread-41',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread' as const,
    };
    const provider = {
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi.fn().mockResolvedValue({
        ...reservedThread,
        messageId: 'thread-message-1',
      }),
      postMessage: vi.fn().mockResolvedValue({
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-41',
        messageId: 'ack-1',
      }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    const result = await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.reserveTaskThread).toHaveBeenCalledWith({
      channelId: 'channel-1',
      name: 'Fix the flaky tests',
      initialText: 'Task request from Matt:\n\nFix the flaky tests',
      selectForumTag: expect.any(Function),
    });
    const selectForumTag = provider.reserveTaskThread.mock.calls[0]?.[0]
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
    expect(mocks.selectDiscordForumTag).toHaveBeenCalledWith({
      taskDescription: 'Fix the flaky tests',
      availableTags: [expect.objectContaining({ id: 'tag-bug' })],
      tracking: { userId: 'user-1' },
    });
    expect(provider.completeTaskThread).toHaveBeenCalledWith({
      thread: reservedThread,
      initialText: 'Task request from Matt:\n\nFix the flaky tests',
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: {
          type: 'standard',
          payload: expect.objectContaining({
            communicationProvider: 'discord',
            communicationGuildId: 'guild-1',
            communicationChannelId: 'channel-1',
            communicationThreadId: 'thread-41',
            communicationMessageId: 'thread-message-1',
            communicationSourceEventId: 'message-1',
            discordTaskThread: true,
          }),
        },
        surface: 'discord',
      }),
      expect.objectContaining({
        launchClass: 'human',
        onEarlyTitleGenerated: expect.any(Function),
      }),
    );
    const enqueueOptions = mocks.enqueueTask.mock.calls[0]?.[1] as {
      onEarlyTitleGenerated: (input: {
        taskRun: { taskId: string };
        title: string;
      }) => Promise<void>;
    };
    const onTitle = enqueueOptions.onEarlyTitleGenerated;
    await onTitle({
      taskRun: { taskId: 'task-41' },
      title: 'Repair flaky authentication tests',
    });
    expect(provider.editChannel).toHaveBeenCalledWith({
      channelId: 'thread-41',
      name: 'Repair flaky authentication tests',
    });
    expect(provider.editChannel).toHaveBeenCalledTimes(1);
    expect(provider.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-41',
        buttons: expect.arrayContaining([
          [
            {
              text: 'Follow',
              url: 'https://roomote.example/tasks/task-41',
            },
          ],
          [{ text: 'Cancel', callbackData: 'discord:cancel:41' }],
        ]),
      }),
    );
    expect(result.createdThread?.channelId).toBe('thread-41');
    expect(mocks.redisSet).toHaveBeenNthCalledWith(
      1,
      'discord:pending_task_thread:message-1',
      JSON.stringify(reservedThread),
      'EX',
      86400,
    );
    expect(mocks.redisSet).toHaveBeenNthCalledWith(
      2,
      'discord:pending_task_thread:message-1',
      JSON.stringify({
        ...reservedThread,
        messageId: 'thread-message-1',
      }),
      'EX',
      86400,
    );
    expect(mocks.redisDel).toHaveBeenCalledWith(
      'discord:pending_task_thread:message-1',
    );
  });

  it('reapplies a newer canonical title when the early rename race loses', async () => {
    const reservedThread = {
      channelId: 'thread-41',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread' as const,
    };
    const provider = {
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi.fn().mockResolvedValue({
        ...reservedThread,
        messageId: 'thread-message-1',
      }),
      postMessage: vi.fn().mockResolvedValue({
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-41',
        messageId: 'ack-1',
      }),
      editChannel: vi.fn().mockResolvedValue({}),
    };
    mocks.dbLimit
      .mockResolvedValueOnce([{ title: 'Manual override title' }])
      .mockResolvedValueOnce([{ title: 'Manual override title' }]);

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-race',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-race',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    const enqueueOptions = mocks.enqueueTask.mock.calls[0]?.[1] as {
      onEarlyTitleGenerated: (input: {
        taskRun: { taskId: string };
        title: string;
      }) => Promise<void>;
    };
    await enqueueOptions.onEarlyTitleGenerated({
      taskRun: { taskId: 'task-41' },
      title: 'Repair flaky authentication tests',
    });

    expect(provider.editChannel).toHaveBeenNthCalledWith(1, {
      channelId: 'thread-41',
      name: 'Repair flaky authentication tests',
    });
    expect(provider.editChannel).toHaveBeenNthCalledWith(2, {
      channelId: 'thread-41',
      name: 'Manual override title',
    });
    expect(provider.editChannel).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the generated-title rename never lands so checkpoint stays open', async () => {
    const reservedThread = {
      channelId: 'thread-41',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread' as const,
    };
    const provider = {
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi.fn().mockResolvedValue({
        ...reservedThread,
        messageId: 'thread-message-1',
      }),
      postMessage: vi.fn().mockResolvedValue({
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-41',
        messageId: 'ack-1',
      }),
      editChannel: vi.fn().mockRejectedValue(
        new DiscordApiError({
          method: 'PATCH',
          path: '/channels/thread-41',
          status: 429,
          message: 'rate limited',
        }),
      ),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-rename-fail',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-rename-fail',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    const enqueueOptions = mocks.enqueueTask.mock.calls[0]?.[1] as {
      onEarlyTitleGenerated: (input: {
        taskRun: { taskId: string };
        title: string;
      }) => Promise<void>;
    };

    await expect(
      enqueueOptions.onEarlyTitleGenerated({
        taskRun: { taskId: 'task-41' },
        title: 'Repair flaky authentication tests',
      }),
    ).rejects.toBeInstanceOf(DiscordApiError);
  });

  it('anchors the task thread to the triggering channel message', async () => {
    const anchoredThread = {
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread' as const,
      messageId: 'message-1',
    };
    const provider = {
      createThreadFromMessage: vi.fn().mockResolvedValue(anchoredThread),
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi.fn().mockResolvedValue(anchoredThread),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      intakeAckPinned: true,
    });

    expect(provider.createThreadFromMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: 'Fix the flaky tests',
    });
    expect(provider.reserveTaskThread).not.toHaveBeenCalled();
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: {
          type: 'standard',
          payload: expect.objectContaining({
            communicationChannelId: 'channel-1',
            communicationThreadId: 'message-1',
            communicationMessageId: 'message-1',
            discordTaskThread: true,
            discordReactionChannelId: 'channel-1',
            discordReactionMessageId: 'message-1',
            discordIntakeAckPending: true,
          }),
        },
      }),
      expect.anything(),
    );
  });

  it('omits discordIntakeAckPending when the pre-enqueue eyes add did not succeed', async () => {
    const anchoredThread = {
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread' as const,
      messageId: 'message-1',
    };
    const provider = {
      createThreadFromMessage: vi.fn().mockResolvedValue(anchoredThread),
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi.fn().mockResolvedValue(anchoredThread),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      // Soft-ack failed (or was never attempted).
      intakeAckPinned: false,
    });

    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: {
          type: 'standard',
          payload: expect.objectContaining({
            discordReactionChannelId: 'channel-1',
            discordReactionMessageId: 'message-1',
          }),
        },
      }),
      expect.anything(),
    );
    const enqueuedPayload = mocks.enqueueTask.mock.calls[0]![0].task
      .payload as {
      discordIntakeAckPending?: boolean;
    };
    expect(enqueuedPayload.discordIntakeAckPending).toBeUndefined();
  });

  it('renames a recovered anchored thread when Discord keeps a stale provisional name', async () => {
    const recoveredThread = {
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'please fix this for <@589419970627239947> Image: image.png',
      kind: 'thread' as const,
      messageId: 'message-1',
    };
    const provider = {
      createThreadFromMessage: vi.fn().mockResolvedValue(recoveredThread),
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi
        .fn()
        .mockImplementation(async ({ thread }) => thread),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'please fix this for @Sky Relifer\n\nImage: image.png',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.createThreadFromMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: 'please fix this for @Sky Relifer',
    });
    expect(provider.editChannel).toHaveBeenCalledWith({
      channelId: 'message-1',
      name: 'please fix this for @Sky Relifer',
    });
  });

  it('renames a Redis-memoized pending thread when it still has a stale provisional name', async () => {
    const stalePendingThread = {
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'please fix this for <@589419970627239947> Image: image.png',
      kind: 'thread' as const,
      messageId: 'message-1',
    };
    mocks.redisGet.mockResolvedValue(JSON.stringify(stalePendingThread));
    const provider = {
      createThreadFromMessage: vi.fn(),
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi
        .fn()
        .mockImplementation(async ({ thread }) => thread),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'please fix this for @Sky Relifer\n\nImage: image.png',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.createThreadFromMessage).not.toHaveBeenCalled();
    expect(provider.editChannel).toHaveBeenCalledWith({
      channelId: 'message-1',
      name: 'please fix this for @Sky Relifer',
    });
    expect(mocks.redisSet).toHaveBeenCalledWith(
      'discord:pending_task_thread:message-1',
      JSON.stringify({
        ...stalePendingThread,
        name: 'please fix this for @Sky Relifer',
      }),
      'EX',
      86400,
    );
  });

  it('persists the acknowledgement message as the reaction target for interaction launches', async () => {
    const provider = {
      reserveTaskThread: vi.fn(),
      createThreadFromMessage: vi.fn(),
      completeTaskThread: vi.fn(),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-dm-1' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Build a fresh dashboard',
        user: 'Matt',
        userId: 'user-1',
        // Interaction snowflake — not a valid Discord reaction target.
        ts: 'interaction-new',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'dm-1',
        communicationMessageId: 'interaction-new',
      },
      channel: {
        channelId: 'dm-1',
        channelName: 'Direct message',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      forceNewThread: true,
    });

    // No origin message id yet at enqueue; reaction coordinates arrive after ack.
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: {
          type: 'standard',
          payload: expect.not.objectContaining({
            discordReactionMessageId: 'interaction-new',
          }),
        },
      }),
      expect.anything(),
    );
    expect(mocks.dbUpdate).toHaveBeenCalled();
    // Intake eyes stay MESSAGE_CREATE-only; interaction launches only need a
    // durable reaction target for terminal/cancel, not a post-enqueue 👀.
    expect(provider.addReaction).not.toHaveBeenCalled();
  });

  it('falls back to a detached thread when the anchor message was deleted', async () => {
    const reservedThread = {
      channelId: 'thread-41',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread' as const,
    };
    const provider = {
      createThreadFromMessage: vi.fn().mockRejectedValue(
        new DiscordApiError({
          method: 'POST',
          path: '/channels/channel-1/messages/message-1/threads',
          status: 404,
          message: 'Unknown Message',
          code: 10008,
        }),
      ),
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi
        .fn()
        .mockResolvedValue({ ...reservedThread, messageId: 'starter-1' }),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.createThreadFromMessage).toHaveBeenCalled();
    expect(provider.reserveTaskThread).toHaveBeenCalledWith({
      channelId: 'channel-1',
      name: 'Fix the flaky tests',
      initialText: 'Task request from Matt:\n\nFix the flaky tests',
      selectForumTag: expect.any(Function),
    });
  });

  it('keeps forum launches as detached forum posts even with an anchor message', async () => {
    const forumPost = {
      channelId: 'post-41',
      parentChannelId: 'forum-1',
      name: 'Fix the flaky tests',
      kind: 'forum_post' as const,
      messageId: 'post-message-1',
    };
    const provider = {
      createThreadFromMessage: vi.fn(),
      reserveTaskThread: vi.fn().mockResolvedValue(forumPost),
      completeTaskThread: vi.fn().mockResolvedValue(forumPost),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn().mockResolvedValue({}),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'forum-1',
        communicationMessageId: 'message-1',
        communicationAnchorMessageId: 'message-1',
      },
      channel: {
        channelId: 'forum-1',
        channelName: 'ideas',
        channelType: 15,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.createThreadFromMessage).not.toHaveBeenCalled();
    expect(provider.reserveTaskThread).toHaveBeenCalled();
  });

  it('keeps direct-message tasks in the DM conversation', async () => {
    const provider = {
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi.fn(),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Explain the repository',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.reserveTaskThread).not.toHaveBeenCalled();
    expect(provider.completeTaskThread).not.toHaveBeenCalled();
    expect(provider.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'dm-1' }),
    );
    expect(provider.postMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      'threadId',
    );
  });

  it('posts a caller-owned kickoff before enqueue and skips the generic acknowledgement', async () => {
    const order: string[] = [];
    mocks.enqueueTask.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ taskId: 'task-41' });
        order.push('enqueued');
        return { id: 41, taskId: 'task-41' };
      },
    );
    const beforeEnqueueKickoff = vi.fn(async () => {
      order.push('kickoff');
    });
    const provider = {
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi.fn(),
      postMessage: vi.fn(),
      editChannel: vi.fn(),
    };

    const result = await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix checkout',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-fast-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'dm-1',
        communicationMessageId: 'message-fast-1',
      },
      channel: {
        channelId: 'dm-1',
        channelName: 'Direct message',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      beforeEnqueueKickoff,
    });

    expect(beforeEnqueueKickoff).toHaveBeenCalledWith({
      taskId: 'task-41',
      taskUrl: 'https://roomote.example/tasks/task-41',
    });
    expect(order).toEqual(['kickoff', 'enqueued']);
    expect(provider.postMessage).not.toHaveBeenCalled();
    expect(result.acknowledgement).toBeNull();
  });

  it('carries an automation initiator and agent prompt override into the task payload', async () => {
    const provider = {
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi.fn(),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };

    await launchDiscordTask({
      provider: provider as never,
      // No launch owner: automation-owned launch for a bot-authored message.
      initiator: {
        kind: 'automation',
        key: 'slack_channel_auto_start',
        actor: { externalId: 'alert-bot', displayName: 'alerts' },
      },
      agentPromptText: 'Alert triage.\n\nDeploy failed for api@1.2.3',
      queuedMessage: {
        provider: 'discord',
        text: 'Deploy failed for api@1.2.3',
        user: 'alerts',
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
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    const [launch, options] = mocks.enqueueTask.mock.calls[0] ?? [];
    expect(launch.task.payload).toEqual(
      expect.objectContaining({
        description: 'Deploy failed for api@1.2.3',
        agentPromptText: 'Alert triage.\n\nDeploy failed for api@1.2.3',
      }),
    );
    expect(launch.initiator).toEqual({
      kind: 'automation',
      key: 'slack_channel_auto_start',
      actor: { externalId: 'alert-bot', displayName: 'alerts' },
    });
    // Automation launches must not force the 'human' class.
    expect(options).not.toHaveProperty('launchClass');
  });

  it('creates a sibling thread for /new inside an existing task thread', async () => {
    const reservedThread = {
      channelId: 'new-thread',
      parentChannelId: 'channel-1',
      name: 'New request',
      kind: 'thread' as const,
    };
    const provider = {
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi.fn().mockResolvedValue({
        ...reservedThread,
        messageId: 'new-root',
      }),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Start something unrelated',
        user: 'Matt',
        userId: 'user-1',
        ts: 'interaction-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'old-thread',
        communicationMessageId: 'interaction-1',
      },
      channel: {
        channelId: 'old-thread',
        channelName: 'Old task',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      forceNewThread: true,
      fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
      fastAgentParent: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'old-thread',
          replyTarget: { channelId: 'channel-1', threadId: 'old-thread' },
        },
      },
    });

    expect(provider.reserveTaskThread).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1' }),
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationThreadId: 'new-thread',
            communicationContextInherited: true,
            fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
            fastAgentParent: {
              sessionId: '11111111-1111-4111-8111-111111111111',
              conversation: {
                surface: 'discord',
                workspaceId: 'guild-1',
                conversationId: 'old-thread',
                replyTarget: {
                  channelId: 'channel-1',
                  threadId: 'old-thread',
                },
              },
            },
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('reuses the pending task thread when a delivery is retried', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({
        channelId: 'thread-existing',
        parentChannelId: 'channel-1',
        name: 'Fix tests',
        kind: 'thread',
        messageId: 'root-existing',
      }),
    );
    const provider = {
      reserveTaskThread: vi.fn(),
      completeTaskThread: vi.fn(async ({ thread }) => thread),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };

    const result = await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-retry',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-retry',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
    });

    expect(provider.reserveTaskThread).not.toHaveBeenCalled();
    expect(provider.completeTaskThread).toHaveBeenCalledWith({
      thread: expect.objectContaining({ channelId: 'thread-existing' }),
      initialText: 'Task request from Matt:\n\nFix tests',
    });
    expect(result.createdThread?.channelId).toBe('thread-existing');
    expect(mocks.redisDel).toHaveBeenCalledWith(
      'discord:pending_task_thread:message-retry',
    );
  });

  it('resumes a failed starter in the reserved thread on redelivery', async () => {
    const reservedThread = {
      channelId: 'thread-reserved',
      parentChannelId: 'channel-1',
      name: 'Fix tests',
      kind: 'thread' as const,
    };
    const completedThread = {
      ...reservedThread,
      messageId: 'thread-root',
    };
    const provider = {
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi
        .fn()
        .mockRejectedValueOnce(new Error('starter unavailable'))
        .mockResolvedValueOnce(completedThread),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };
    const launch = () =>
      launchDiscordTask({
        provider: provider as never,
        launchOwnerUserId: 'user-1',
        queuedMessage: {
          provider: 'discord',
          text: 'Fix tests',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-starter-retry',
        },
        metadata: {
          communicationProvider: 'discord',
          communicationGuildId: 'guild-1',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'message-starter-retry',
        },
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType: 0,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
        workspace: {
          repoForPayload: 'acme/repo',
          workspaceDisplayName: 'Acme',
        },
      });

    await expect(launch()).rejects.toThrow('starter unavailable');
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
    expect(mocks.redisSet).toHaveBeenNthCalledWith(
      1,
      'discord:pending_task_thread:message-starter-retry',
      JSON.stringify(reservedThread),
      'EX',
      86400,
    );

    mocks.redisGet.mockResolvedValue(JSON.stringify(reservedThread));
    await expect(launch()).resolves.toMatchObject({
      createdThread: completedThread,
    });

    expect(provider.reserveTaskThread).toHaveBeenCalledTimes(1);
    expect(provider.completeTaskThread).toHaveBeenCalledTimes(2);
    expect(provider.completeTaskThread).toHaveBeenLastCalledWith({
      thread: reservedThread,
      initialText: 'Task request from Matt:\n\nFix tests',
    });
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenNthCalledWith(
      2,
      'discord:pending_task_thread:message-starter-retry',
      JSON.stringify(completedThread),
      'EX',
      86400,
    );
  });

  it('keeps the pending task thread reservation when enqueue fails', async () => {
    mocks.enqueueTask.mockRejectedValue(new Error('queue unavailable'));
    const reservedThread = {
      channelId: 'thread-retry',
      parentChannelId: 'channel-1',
      name: 'Fix tests',
      kind: 'thread' as const,
    };
    const provider = {
      reserveTaskThread: vi.fn().mockResolvedValue(reservedThread),
      completeTaskThread: vi.fn().mockResolvedValue({
        ...reservedThread,
        messageId: 'thread-root',
      }),
      postMessage: vi.fn(),
      editChannel: vi.fn(),
    };

    await expect(
      launchDiscordTask({
        provider: provider as never,
        launchOwnerUserId: 'user-1',
        queuedMessage: {
          provider: 'discord',
          text: 'Fix tests',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-failed',
        },
        metadata: {
          communicationProvider: 'discord',
          communicationGuildId: 'guild-1',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'message-failed',
        },
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType: 0,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
        workspace: {
          repoForPayload: 'acme/repo',
          workspaceDisplayName: 'Acme',
        },
      }),
    ).rejects.toThrow('queue unavailable');

    expect(mocks.redisSet).toHaveBeenCalled();
    expect(mocks.redisDel).not.toHaveBeenCalled();
    expect(provider.postMessage).not.toHaveBeenCalled();
  });

  it('turns a caller-supplied message into the acknowledgement', async () => {
    const anchoredThread = {
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'Fix tests',
      kind: 'thread' as const,
      messageId: 'message-1',
    };
    const provider = {
      createThreadFromMessage: vi.fn().mockResolvedValue(anchoredThread),
      completeTaskThread: vi.fn().mockResolvedValue(anchoredThread),
      editInteractionResponse: vi
        .fn()
        .mockResolvedValue({ messageId: 'card-1' }),
      postMessage: vi.fn(),
      editChannel: vi.fn(),
    };

    const launched = await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: { repoForPayload: 'acme/repo', workspaceDisplayName: 'Acme' },
      replaceMessage: {
        interaction: {
          applicationId: 'app-1',
          interaction: {
            id: 'interaction-1',
            application_id: 'app-1',
            type: 3,
            token: 'token-1',
            channel_id: 'message-1',
          } as never,
          interactionDeferred: true,
        },
        channel: {
          channelId: 'message-1',
          channelName: 'Fix tests',
          channelType: 11,
          guildId: 'guild-1',
          parentChannelId: 'channel-1',
          isDirectMessage: false,
          isThread: true,
        },
      },
    });

    expect(provider.postMessage).not.toHaveBeenCalled();
    expect(provider.editInteractionResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionToken: 'token-1',
        text: 'Started a task in Acme.',
        buttons: [
          [
            {
              text: 'Follow',
              url: 'https://roomote.example/tasks/task-41',
            },
          ],
          [{ text: 'Cancel', callbackData: 'discord:cancel:41' }],
        ],
      }),
    );
    expect(launched.acknowledgement).toEqual({ messageId: 'card-1' });
  });

  it('posts the acknowledgement when the message it should replace is gone', async () => {
    // A card that cannot be edited must not take the acknowledgement down with
    // it; the task is already running and still needs its cancel control.
    const anchoredThread = {
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'Fix tests',
      kind: 'thread' as const,
      messageId: 'message-1',
    };
    const provider = {
      createThreadFromMessage: vi.fn().mockResolvedValue(anchoredThread),
      completeTaskThread: vi.fn().mockResolvedValue(anchoredThread),
      editInteractionResponse: vi.fn().mockRejectedValue(
        new DiscordApiError({
          method: 'PATCH',
          path: '/webhooks/app-1/token-1/messages/@original',
          status: 404,
          message: 'Unknown Message',
          code: 10008,
        }),
      ),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix tests',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
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
      workspace: { repoForPayload: 'acme/repo', workspaceDisplayName: 'Acme' },
      replaceMessage: {
        interaction: {
          applicationId: 'app-1',
          interaction: {
            id: 'interaction-1',
            application_id: 'app-1',
            type: 3,
            token: 'token-1',
            channel_id: 'message-1',
          } as never,
          interactionDeferred: true,
        },
        channel: {
          channelId: 'message-1',
          channelName: 'Fix tests',
          channelType: 11,
          guildId: 'guild-1',
          parentChannelId: 'channel-1',
          isDirectMessage: false,
          isThread: true,
        },
      },
    });

    expect(provider.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'message-1',
        text: 'Started a task in Acme.',
      }),
    );
  });

  it('posts the router free-form kickoff as the acknowledgement text', async () => {
    const provider = {
      reserveTaskThread: vi.fn(),
      createThreadFromMessage: vi.fn(),
      completeTaskThread: vi.fn(),
      postMessage: vi.fn().mockResolvedValue({ messageId: 'ack-1' }),
      editChannel: vi.fn(),
    };

    await launchDiscordTask({
      provider: provider as never,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky tests',
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
        channelName: 'dm',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      kickoffMessage: 'Digging into the flaky tests in Acme.',
    });

    expect(provider.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-1',
        text: 'Digging into the flaky tests in Acme.',
      }),
    );
  });
});
