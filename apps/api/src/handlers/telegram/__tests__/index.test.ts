import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addReactionMock,
  answerCallbackQueryMock,
  authUsersFindFirstMock,
  taskRunsFindFirstMock,
  consumeLinkCodeMock,
  createForumTopicMock,
  downloadFileMock,
  restoreLinkCodeMock,
  editMessageReplyMarkupMock,
  editMessageTextMock,
  enqueueTaskMock,
  environmentsFindFirstMock,
  envMock,
  getAvailableEnvironmentsMock,
  getBotInfoMock,
  getTaskUrlMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  postMessageMock,
  queueCommunicationMessageMock,
  redisDelMock,
  redisGetMock,
  redisGetdelMock,
  redisSetMock,
  setLatestInboundMessageIdMock,
  setTrustedRunActingUserMock,
  stopTaskRunMock,
  updateMock,
  updateReturningMock,
  usersFindFirstMock,
  telegramMappingsFindFirstMock,
  appendAccountLinkHelpTextMock,
  continueFastReplyMock,
  queueFastReplyMock,
  findFastMessageSessionMock,
  findFastReplySessionMock,
  getFastSessionMock,
  isFastProviderMessageMock,
} = vi.hoisted(() => ({
  addReactionMock: vi.fn(),
  answerCallbackQueryMock: vi.fn(),
  authUsersFindFirstMock: vi.fn(),
  taskRunsFindFirstMock: vi.fn(),
  consumeLinkCodeMock: vi.fn(),
  createForumTopicMock: vi.fn(),
  downloadFileMock: vi.fn(),
  restoreLinkCodeMock: vi.fn(),
  editMessageReplyMarkupMock: vi.fn(),
  editMessageTextMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  environmentsFindFirstMock: vi.fn(),
  getAvailableEnvironmentsMock: vi.fn(),
  getBotInfoMock: vi.fn(),
  envMock: {
    R_APP_URL: 'https://app.example.com',
    R_TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
    R_TELEGRAM_WEBHOOK_SECRET: 'secret' as string | undefined,
    TRPC_URL: 'https://api.example.com' as string | undefined,
  },
  getTaskUrlMock: vi.fn(() => 'https://app.example.com/task/task-new'),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  postMessageMock: vi.fn(),
  queueCommunicationMessageMock: vi.fn(),
  redisDelMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisGetdelMock: vi.fn(),
  redisSetMock: vi.fn(),
  setLatestInboundMessageIdMock: vi.fn(),
  setTrustedRunActingUserMock: vi.fn(),
  stopTaskRunMock: vi.fn(),
  updateMock: vi.fn(),
  updateReturningMock: vi.fn(),
  usersFindFirstMock: vi.fn(),
  telegramMappingsFindFirstMock: vi.fn(),
  appendAccountLinkHelpTextMock: vi.fn(async (message: string) => message),
  continueFastReplyMock: vi.fn(),
  queueFastReplyMock: vi.fn(),
  findFastMessageSessionMock: vi.fn(),
  findFastReplySessionMock: vi.fn(),
  getFastSessionMock: vi.fn(),
  isFastProviderMessageMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: envMock,
}));

vi.mock('../../account-link-help.js', () => ({
  appendAccountLinkHelpText: appendAccountLinkHelpTextMock,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    set: redisSetMock,
    del: redisDelMock,
    get: redisGetMock,
    getdel: redisGetdelMock,
  })),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  asc: vi.fn((column: unknown) => ({ asc: column })),
  setTrustedRunActingUser: setTrustedRunActingUserMock,
  authUsers: {
    id: 'authUserId',
  },
  taskRuns: {
    canceledAt: 'canceledAt',
    createdAt: 'createdAt',
    payload: 'payload',
    snapshotCreatedAt: 'snapshotCreatedAt',
    snapshotId: 'snapshotId',
    status: 'status',
    id: 'id',
    taskId: 'taskId',
    actingUserId: 'actingUserId',
    port: 'port',
    result: 'result',
  },
  tasks: {
    id: 'tasks.id',
    initiatorUserId: 'tasks.initiatorUserId',
  },
  db: {
    insert: insertMock,
    update: updateMock,
    // The Telegram job lookups moved from db.query.taskRuns.findFirst to
    // db.select(...).from(taskRuns).innerJoin(tasks). Adapt the select chain
    // onto the same sequential mock queue so per-test row sequences keep
    // working; legacy `userId` keys map to run actingUserId.
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => {
          const row = (await taskRunsFindFirstMock()) as Record<
            string,
            unknown
          > | null;

          if (!row) {
            return [];
          }

          const { userId, ...rest } = row;

          return [
            {
              actingUserId: userId ?? null,
              initiatorUserId: userId ?? null,
              ...rest,
            },
          ];
        },
      };
      return chain;
    },
    query: {
      authAccounts: {
        findFirst: vi.fn(),
      },
      authUsers: {
        findFirst: authUsersFindFirstMock,
      },
      environments: {
        findFirst: environmentsFindFirstMock,
      },
      taskRuns: {
        findFirst: taskRunsFindFirstMock,
      },
      users: {
        findFirst: usersFindFirstMock,
      },
      telegramUserMappings: {
        findFirst: telegramMappingsFindFirstMock,
      },
      trackedMessages: {
        findFirst: vi.fn(),
      },
    },
  },
  desc: vi.fn((column: unknown) => ({ desc: column })),
  environments: {
    id: 'environmentId',
  },
  environmentVariables: {
    name: 'name',
  },
  telegramUserMappings: {
    telegramUserId: 'telegramUserId',
    userId: 'userId',
  },
  trackedMessages: {
    id: 'id',
    kind: 'kind',
    channelId: 'channelId',
    messageTs: 'messageTs',
    workItemId: 'workItemId',
    metadata: 'metadata',
  },
  workItems: {
    id: 'id',
    status: 'status',
    title: 'title',
    brief: 'brief',
    investigationContext: 'investigationContext',
    targetRepositoryFullName: 'targetRepositoryFullName',
    launchClaimedAt: 'launchClaimedAt',
  },
  like: vi.fn((column: unknown, pattern: unknown) => ({
    like: [column, pattern],
  })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({
    inArray: [column, values],
  })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  lt: vi.fn((column: unknown, value: unknown) => ({ lt: [column, value] })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings,
    values,
  })),
  users: {
    deletedAt: 'deletedAt',
    id: 'userId',
  },
  resolveEffectiveDeploymentEnvVars: vi.fn(async () => ({})),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: envMock.R_TELEGRAM_BOT_TOKEN ?? null,
    webhookSecret: envMock.R_TELEGRAM_WEBHOOK_SECRET ?? null,
    botUsername: 'roomote_bot',
  })),
}));

vi.mock('@roomote/communication/messages', () => ({
  queueCommunicationMessage: queueCommunicationMessageMock,
  setLatestInboundMessageId: setLatestInboundMessageIdMock,
}));

vi.mock('@roomote/sdk/server', () => ({
  continueFastAgentSurfaceReply: continueFastReplyMock,
  createTelegramCommunicationProviderFromRuntimeCredentials: vi.fn(async () =>
    envMock.R_TELEGRAM_BOT_TOKEN
      ? {
          addReaction: addReactionMock,
          answerCallbackQuery: answerCallbackQueryMock,
          createForumTopic: createForumTopicMock,
          downloadFile: downloadFileMock,
          getBotInfo: getBotInfoMock,
          editMessageReplyMarkup: editMessageReplyMarkupMock,
          editMessageText: editMessageTextMock,
          postMessage: postMessageMock,
        }
      : null,
  ),
  enqueueTelegramSuggestedTasksOnboardingFollowup: vi.fn(),
  consumeTelegramLinkCode: consumeLinkCodeMock,
  restoreTelegramLinkCode: restoreLinkCodeMock,
  isTelegramLinkCode: (value: string) =>
    /^link-[A-Za-z0-9_-]{16,}$/.test(value.trim()),
  findTelegramPrimaryChatId: vi.fn(async () => null),
  findFastAgentSessionForProviderMessage: findFastMessageSessionMock,
  findFastAgentSessionForProviderReply: findFastReplySessionMock,
  isFastAgentProviderMessage: isFastProviderMessageMock,
  queueFastAgentSurfaceReply: queueFastReplyMock,
  TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME: 'TELEGRAM_PRIMARY_CHAT_ID',
  claimPendingPrReviewAction: vi.fn(async () => null),
  claimPendingPrReviewActionsForThread: vi.fn(async () => []),
  dispatchPrReviewFollowUp: vi.fn(),
  enableAutoHandlePrReviewFeedback: vi.fn(),
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
    return {
      addReaction: addReactionMock,
      answerCallbackQuery: answerCallbackQueryMock,
      createForumTopic: createForumTopicMock,
      downloadFile: downloadFileMock,
      getBotInfo: getBotInfoMock,
      editMessageReplyMarkup: editMessageReplyMarkupMock,
      editMessageText: editMessageTextMock,
      postMessage: postMessageMock,
    };
  }),
}));

vi.mock('../../tasks/task-stop.js', () => ({
  stopTaskRun: stopTaskRunMock,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildFastAgentReactionExternalInputQuestion: vi.fn(
    (input: unknown) =>
      `<external_input>${JSON.stringify(input)}</external_input>`,
  ),
  enqueueTask: enqueueTaskMock,
  getAvailableEnvironments: getAvailableEnvironmentsMock,
  getTaskUrl: getTaskUrlMock,
  getOrCreateFastAgentSession: getFastSessionMock,
}));

import { telegram } from '../index';

function createApp() {
  const app = new Hono();

  app.route('/telegram', telegram);

  return app;
}

function createTelegramUpdate(
  overrides: {
    message?: Record<string, unknown>;
    [key: string]: unknown;
  } = {},
) {
  const { message: messageOverrides, ...updateOverrides } = overrides;

  return {
    update_id: 123,
    message: {
      message_id: 456,
      date: 1,
      text: 'continue the task',
      from: {
        id: 111,
        first_name: 'Ada',
        last_name: 'Lovelace',
        username: 'ada',
      },
      chat: {
        id: 222,
        type: 'private',
        first_name: 'Ada',
        username: 'ada',
      },
      ...messageOverrides,
    },
    ...updateOverrides,
  };
}

async function postTelegramUpdate(update: unknown) {
  return createApp().request('/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret',
    },
    body: JSON.stringify(update),
  });
}

function mockTelegramLinkedSender(userId = 'launch-owner-1') {
  telegramMappingsFindFirstMock.mockResolvedValueOnce({ userId });
  usersFindFirstMock.mockResolvedValueOnce({ id: userId, deletedAt: null });
}

describe('Telegram webhook handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendAccountLinkHelpTextMock.mockImplementation(
      async (message: string) => message,
    );

    // Some tests queue one-shot lookup results on these mocks. Reset them so
    // later tests do not inherit stale values when the whole suite runs.
    authUsersFindFirstMock.mockReset();
    usersFindFirstMock.mockReset();
    downloadFileMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filePath: 'photos/example.jpg',
      contentType: 'image/jpeg',
    });
    taskRunsFindFirstMock.mockReset();
    telegramMappingsFindFirstMock.mockReset();
    consumeLinkCodeMock.mockReset();
    continueFastReplyMock.mockResolvedValue(true);
    queueFastReplyMock.mockResolvedValue(true);
    findFastMessageSessionMock.mockResolvedValue(null);
    findFastReplySessionMock.mockResolvedValue(null);
    getFastSessionMock.mockResolvedValue({ id: 'fast-session-default' });
    isFastProviderMessageMock.mockResolvedValue(false);

    envMock.R_APP_URL = 'https://app.example.com';
    envMock.R_TELEGRAM_BOT_TOKEN = 'bot-token';
    envMock.R_TELEGRAM_WEBHOOK_SECRET = 'secret';
    envMock.TRPC_URL = 'https://api.example.com';
    redisSetMock.mockResolvedValue('OK');
    redisDelMock.mockResolvedValue(1);
    redisGetMock.mockResolvedValue(null);
    redisGetdelMock.mockResolvedValue(null);
    environmentsFindFirstMock.mockResolvedValue(undefined);
    getAvailableEnvironmentsMock.mockResolvedValue([]);
    editMessageTextMock.mockResolvedValue(undefined);
    setLatestInboundMessageIdMock.mockResolvedValue(undefined);
    authUsersFindFirstMock.mockResolvedValue(null);
    usersFindFirstMock.mockResolvedValue(null);
    taskRunsFindFirstMock.mockResolvedValue(null);
    telegramMappingsFindFirstMock.mockResolvedValue(null);
    consumeLinkCodeMock.mockResolvedValue(null);
    createForumTopicMock.mockRejectedValue(
      new Error('Bad Request: chat is not a forum'),
    );
    getBotInfoMock.mockResolvedValue({ hasTopicsEnabled: true });
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
      onConflictDoUpdate: insertOnConflictDoNothingMock,
    });
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: updateReturningMock }),
      }),
    });
    updateReturningMock.mockResolvedValue([]);
    queueCommunicationMessageMock.mockResolvedValue(undefined);
    enqueueTaskMock.mockResolvedValue({
      id: 88,
      taskId: 'task-new',
    });
    postMessageMock.mockResolvedValue({ messageId: 'telegram-response' });
  });

  it('queues a new reaction on the owner’s bound Fast message', async () => {
    findFastMessageSessionMock.mockResolvedValue({
      id: 'fast-session-1',
      userId: 'mapped-user-1',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:mapped-user-1',
        replyTarget: { channelId: '222' },
      },
    });
    mockTelegramLinkedSender('mapped-user-1');

    const response = await postTelegramUpdate({
      update_id: 124,
      message_reaction: {
        chat: { id: 222, type: 'private' },
        message_id: 777,
        date: 1_700_000_000,
        user: {
          id: 111,
          first_name: 'Ada',
          last_name: 'Lovelace',
          username: 'ada',
        },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '❤️' }],
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastReactionQueued: true,
    });
    expect(findFastMessageSessionMock).toHaveBeenCalledWith({
      provider: 'telegram',
      workspaceId: '222',
      channelId: '222',
      messageId: '777',
    });
    expect(queueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'fast-session-1',
        userId: 'mapped-user-1',
        currentMessageId: 'telegram-reaction:124',
        replyToMessageId: '777',
        externalInput: expect.objectContaining({
          provider: 'telegram',
          reactions: [{ name: '❤️' }],
        }),
      }),
    );
  });

  it('rejects a reaction from a different Fast session owner', async () => {
    findFastMessageSessionMock.mockResolvedValue({
      id: 'fast-session-1',
      userId: 'another-user',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:another-user',
        replyTarget: { channelId: '222' },
      },
    });
    mockTelegramLinkedSender('mapped-user-1');

    const response = await postTelegramUpdate({
      update_id: 125,
      message_reaction: {
        chat: { id: 222, type: 'private' },
        message_id: 777,
        date: 1_700_000_000,
        user: { id: 111, first_name: 'Ada' },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'fast_session_user_mismatch',
    });
    expect(queueFastReplyMock).not.toHaveBeenCalled();
  });

  it('ignores reaction removals without starting Fast or a suggestion', async () => {
    const response = await postTelegramUpdate({
      update_id: 126,
      message_reaction: {
        chat: { id: 222, type: 'private' },
        message_id: 777,
        date: 1_700_000_000,
        user: { id: 111, first_name: 'Ada' },
        old_reaction: [{ type: 'emoji', emoji: '👍' }],
        new_reaction: [],
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'reaction_removed_or_unchanged',
    });
    expect(findFastMessageSessionMock).not.toHaveBeenCalled();
    expect(queueFastReplyMock).not.toHaveBeenCalled();
  });

  it('remembers implicit Telegram topics so the task title can replace New Chat', async () => {
    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: undefined,
          message_thread_id: 77,
          forum_topic_created: {
            name: 'New Chat',
            is_name_implicit: true,
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      implicitTopicRemembered: true,
    });
    expect(redisSetMock).toHaveBeenCalledWith(
      'telegram:implicit-topic:222:77',
      '1',
      'EX',
      60 * 60,
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('uses Fast for a linked Telegram direct message', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    getFastSessionMock.mockResolvedValueOnce({
      id: '11111111-1111-4111-8111-111111111111',
    });

    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(getFastSessionMock).toHaveBeenCalledWith({
      userId: 'mapped-user-1',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:mapped-user-1',
        replyTarget: { channelId: '222' },
      },
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith({
      sessionId: '11111111-1111-4111-8111-111111111111',
      userId: 'mapped-user-1',
      senderDisplayName: 'Ada Lovelace',
      question: 'continue the task',
      currentMessageId: '456',
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('continues a Telegram Fast reply before ordinary task routing', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    findFastReplySessionMock.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      userId: 'mapped-user-1',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:mapped-user-1',
        replyTarget: { channelId: '222' },
      },
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          reply_to_message: {
            message_id: 400,
            date: 1,
            text: 'Fast answer',
            chat: { id: 222, type: 'private' },
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastContinued: true,
    });
    expect(findFastReplySessionMock).toHaveBeenCalledWith({
      provider: 'telegram',
      workspaceId: '222',
      channelId: '222',
      replyToMessageId: '400',
      userId: 'mapped-user-1',
    });
    expect(queueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '22222222-2222-4222-8222-222222222222',
        userId: 'mapped-user-1',
        question: 'continue the task',
      }),
    );
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('does not acknowledge a Telegram Fast reply when durable admission fails', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    findFastReplySessionMock.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      userId: 'mapped-user-1',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:mapped-user-1',
        replyTarget: { channelId: '222' },
      },
    });
    queueFastReplyMock.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          reply_to_message: {
            message_id: 400,
            date: 1,
            text: 'Fast answer',
            chat: { id: 222, type: 'private' },
          },
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(addReactionMock).not.toHaveBeenCalled();
    expect(redisDelMock).toHaveBeenCalledWith('telegram:update:123');
  });

  it('fails closed when a Telegram reply targets a Fast message on another route', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    isFastProviderMessageMock.mockResolvedValueOnce(true);

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          reply_to_message: {
            message_id: 400,
            date: 1,
            text: 'Fast answer',
            chat: { id: 222, type: 'private' },
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'fast_session_route_mismatch',
    });
    expect(isFastProviderMessageMock).toHaveBeenCalledWith({
      provider: 'telegram',
      messageId: '400',
      workspaceId: '222',
      channelId: '222',
    });
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('passes Telegram photos to a new Fast session', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    getFastSessionMock.mockResolvedValueOnce({
      id: '33333333-3333-4333-8333-333333333333',
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: undefined,
          caption: 'Inspect this screenshot',
          photo: [
            {
              file_id: 'photo-large',
              file_unique_id: 'photo-1',
              width: 1024,
              height: 768,
            },
          ],
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Inspect this screenshot',
        images: ['data:image/jpeg;base64,AQID'],
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('uses a user-scoped Fast session for a Telegram group topic mention', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    getFastSessionMock.mockResolvedValueOnce({
      id: '44444444-4444-4444-8444-444444444444',
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '@roomote_bot inspect this topic',
          entities: [{ type: 'mention', offset: 0, length: 12 }],
          message_thread_id: 77,
          chat: { id: -1007, type: 'supergroup', title: 'Engineering' },
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(getFastSessionMock).toHaveBeenCalledWith({
      userId: 'mapped-user-1',
      conversation: {
        surface: 'telegram',
        workspaceId: '-1007',
        conversationId: '77:user:mapped-user-1',
        replyTarget: { channelId: '-1007', threadId: '77' },
      },
    });
  });

  it('continues a user-owned Telegram Fast topic without another mention', async () => {
    mockTelegramLinkedSender('mapped-user-1');
    findFastReplySessionMock.mockResolvedValueOnce({
      id: '55555555-5555-4555-8555-555555555555',
      userId: 'mapped-user-1',
      conversation: {
        surface: 'telegram',
        workspaceId: '-1007',
        conversationId: '77:user:mapped-user-1',
        replyTarget: { channelId: '-1007', threadId: '77' },
      },
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'keep going',
          message_thread_id: 77,
          chat: { id: -1007, type: 'supergroup', title: 'Engineering' },
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      fastAnswered: true,
      fastContinued: true,
    });
    expect(findFastReplySessionMock).toHaveBeenCalledWith({
      provider: 'telegram',
      workspaceId: '-1007',
      channelId: '-1007',
      threadId: '77',
      userId: 'mapped-user-1',
    });
    expect(queueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'keep going' }),
    );
  });

  it('nudges an unlinked sender to link and drops the message', async () => {
    appendAccountLinkHelpTextMock.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );
    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
    expect(response.status).toBe(200);
    expect(redisSetMock).toHaveBeenCalledWith(
      'telegram:update:123',
      '1',
      'EX',
      300,
      'NX',
    );
    expect(taskRunsFindFirstMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringContaining('Linked Accounts'),
        textFormat: 'markdown',
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0].text).toContain(
      'Ask an admin for an invite.',
    );
  });

  it('nudges an unlinked group sender who addressed the bot with a deep-link button', async () => {
    appendAccountLinkHelpTextMock.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );
    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '@roomote_bot fix the tests',
          chat: { id: -1007, type: 'group', title: 'Engineering' },
          entities: [{ type: 'mention', offset: 0, length: 12 }],
        },
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0].text).toContain(
      'Ask an admin for an invite.',
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '-1007',
        replyToMessageId: '456',
        text: expect.stringContaining('Link your Telegram account'),
        buttons: [
          [
            expect.objectContaining({
              url: 'https://t.me/roomote_bot?start=link',
            }),
          ],
        ],
      }),
    );
    // The debounce claims both the per-user and per-chat windows.
    expect(redisSetMock).toHaveBeenCalledWith(
      'telegram:link-nudge:user:-1007:111',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(redisSetMock).toHaveBeenCalledWith(
      'telegram:link-nudge:chat:-1007',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('nudges an unlinked group /new sender with a deep-link button', async () => {
    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/new@roomote_bot fix the tests',
          chat: { id: -1007, type: 'group', title: 'Engineering' },
          entities: [{ type: 'bot_command', offset: 0, length: 16 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              url: 'https://t.me/roomote_bot?start=link',
            }),
          ],
        ],
      }),
    );
  });

  it('suppresses the group link nudge while the debounce window is claimed', async () => {
    // Update dedup claims succeed; nudge debounce claims fail (already sent).
    redisSetMock.mockImplementation(async (key: string) =>
      key.startsWith('telegram:update:') ? 'OK' : null,
    );

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '@roomote_bot fix the tests',
          chat: { id: -1007, type: 'group', title: 'Engineering' },
          entities: [{ type: 'mention', offset: 0, length: 12 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('silently ignores unaddressed group messages from unlinked senders', async () => {
    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'just chatting with the team',
          chat: { id: -1007, type: 'group', title: 'Engineering' },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
  });

  it('replies with linking instructions to the /start link deep link', async () => {
    appendAccountLinkHelpTextMock.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );
    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start link',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0].text).toContain(
      'Ask an admin for an invite.',
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      linkNudged: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringContaining('Linked Accounts'),
      }),
    );
  });

  it('tells already-linked senders so on /start link', async () => {
    mockTelegramLinkedSender('linked-user-15');

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start link',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      linkNudged: true,
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already linked'),
      }),
    );
  });

  it('queues active-run messages for a linked sender', async () => {
    mockTelegramLinkedSender();
    taskRunsFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });

    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(response.status).toBe(200);
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith('telegram', 77, {
      provider: 'telegram',
      text: 'continue the task',
      user: 'Ada Lovelace',
      userId: 'launch-owner-1',
      ts: '456',
      channel: '222',
    });
    expect(setLatestInboundMessageIdMock).toHaveBeenCalledWith(
      'telegram',
      77,
      '456',
    );
    expect(setTrustedRunActingUserMock).toHaveBeenCalledWith({
      runId: 77,
      userId: 'launch-owner-1',
    });
    expect(getFastSessionMock).not.toHaveBeenCalled();
  });

  it('queues a captioned photo as an active-run follow-up', async () => {
    mockTelegramLinkedSender();
    taskRunsFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: undefined,
          caption: 'What can you see here?',
          photo: [
            {
              file_id: 'photo-large',
              file_unique_id: 'photo-1',
              width: 1280,
              height: 720,
            },
          ],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      77,
      expect.objectContaining({
        text: 'What can you see here?',
        images: ['data:image/jpeg;base64,AQID'],
      }),
    );
  });

  it('answers a /start request in Fast as the linked sender', async () => {
    mockTelegramLinkedSender('launch-owner-2');
    taskRunsFindFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start please check this',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(getFastSessionMock).toHaveBeenCalledWith({
      userId: 'launch-owner-2',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:launch-owner-2',
        replyTarget: { channelId: '222' },
      },
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'fast-session-default',
        userId: 'launch-owner-2',
        question: 'please check this',
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('replies with an error when the Fast session cannot be started', async () => {
    mockTelegramLinkedSender('launch-owner-2');
    getFastSessionMock.mockRejectedValueOnce(new Error('Fast unavailable'));

    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      fastUnavailable: true,
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining("couldn't start a conversation"),
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(continueFastReplyMock).not.toHaveBeenCalled();
  });

  it('resumes a completed Telegram snapshot before starting a new task', async () => {
    mockTelegramLinkedSender('launch-owner-4');
    taskRunsFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 55,
      status: 'completed',
      taskId: 'task-old',
      payload: {
        repo: 'RooCodeInc/Roomote',
        environmentId: 'env-1',
        communicationProvider: 'telegram',
        communicationChannelId: '222',
        communicationMessageId: '123',
      },
      port: 3000,
      snapshotId: 'snapshot-1',
      snapshotCreatedAt: new Date(),
    });
    enqueueTaskMock.mockResolvedValueOnce({
      id: 99,
      taskId: 'task-resumed',
    });
    getTaskUrlMock.mockReturnValueOnce(
      'https://app.example.com/task/task-resumed',
    );

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start continue this',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      resumed: true,
      runId: 99,
    });
    expect(response.status).toBe(200);
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'launch-owner-4',
        task: expect.objectContaining({
          type: 'snapshot_resume',
          sourceSnapshotId: 'snapshot-1',
          sourceRunId: 55,
          payload: expect.objectContaining({
            repo: 'RooCodeInc/Roomote',
            environmentId: 'env-1',
            port: 3000,
            sourceSnapshotId: 'snapshot-1',
            sourceRunId: 55,
            queuedCommunicationMessages: [
              expect.objectContaining({
                provider: 'telegram',
                text: 'continue this',
                userId: 'launch-owner-4',
              }),
            ],
            communicationProvider: 'telegram',
            communicationChannelId: '222',
            communicationMessageId: '456',
          }),
        }),
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining('Reconnected this Telegram chat'),
      }),
    );
  });

  it('does not silently resume a completed task from a user-owned forum topic', async () => {
    mockTelegramLinkedSender('launch-owner-4');
    taskRunsFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 55,
      status: 'completed',
      taskId: 'task-old',
      payload: {
        repo: 'RooCodeInc/Roomote',
        communicationProvider: 'telegram',
        communicationChannelId: '-100222',
        communicationThreadId: '77',
      },
      snapshotId: 'snapshot-1',
      snapshotCreatedAt: new Date(),
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          message_thread_id: 77,
          text: 'ordinary group chatter',
          chat: {
            id: -100222,
            type: 'supergroup',
            title: 'Engineering',
            is_forum: true,
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'not_task_entry',
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('answers a reply to the exact announcer report root in Fast', async () => {
    mockTelegramLinkedSender('launch-owner-report');
    taskRunsFindFirstMock
      .mockResolvedValueOnce({
        id: 55,
        status: 'completed',
        taskId: 'announcer-task',
        payload: { backgroundAutomationKey: 'announcer' },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'Can you explain the release impact?',
          reply_to_message: { message_id: 900, date: 1, chat: { id: 222 } },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Can you explain the release impact?',
        currentMessageId: '456',
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('routes a reply to its exact active announcer root instead of a newer run in the chat', async () => {
    mockTelegramLinkedSender('launch-owner-report');
    taskRunsFindFirstMock
      .mockResolvedValueOnce({
        id: 55,
        status: 'running',
        taskId: 'announcer-task-one',
        payload: { backgroundAutomationKey: 'announcer' },
      })
      .mockResolvedValueOnce({
        id: 99,
        status: 'running',
        taskId: 'announcer-task-two',
        payload: {},
      });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'Follow up on the first report',
          reply_to_message: { message_id: 900, date: 1, chat: { id: 222 } },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 55,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      55,
      expect.objectContaining({ text: 'Follow up on the first report' }),
    );
    expect(taskRunsFindFirstMock).toHaveBeenCalledTimes(1);
  });

  it('resumes the exact announcer root snapshot instead of a newer run in the chat', async () => {
    mockTelegramLinkedSender('launch-owner-report');
    taskRunsFindFirstMock
      .mockResolvedValueOnce({
        id: 55,
        status: 'completed',
        taskId: 'announcer-task-one',
        payload: {
          repo: 'RooCodeInc/Roomote',
          environmentId: 'env-1',
          backgroundAutomationKey: 'announcer',
        },
        port: 3000,
        snapshotId: 'snapshot-one',
        snapshotCreatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 99,
        status: 'running',
        taskId: 'announcer-task-two',
        payload: {},
      });
    enqueueTaskMock.mockResolvedValueOnce({ id: 100, taskId: 'task-resumed' });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'Follow up on the first report',
          reply_to_message: { message_id: 900, date: 1, chat: { id: 222 } },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      resumed: true,
      runId: 100,
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'snapshot_resume',
          sourceRunId: 55,
          sourceSnapshotId: 'snapshot-one',
        }),
      }),
      expect.anything(),
    );
    expect(taskRunsFindFirstMock).toHaveBeenCalledTimes(1);
  });

  it('/new bypasses a resumable snapshot and starts a fresh conversation', async () => {
    mockTelegramLinkedSender('launch-owner-5');
    // First findFirst: active-run lookup (none). Second findFirst: completed
    // snapshot lookup would normally resume, but /new skips it entirely.
    taskRunsFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 55,
      status: 'completed',
      taskId: 'task-old',
      payload: {
        repo: 'RooCodeInc/Roomote',
        communicationProvider: 'telegram',
        communicationChannelId: '222',
      },
      snapshotId: 'snapshot-1',
      snapshotCreatedAt: new Date(),
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/new fix the flaky auth test',
          entities: [{ type: 'bot_command', offset: 0, length: 4 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastStartedNew: true,
    });
    expect(response.status).toBe(200);
    // A plain private chat keeps one conversation, so the request joins it.
    expect(getFastSessionMock).toHaveBeenCalledWith({
      userId: 'launch-owner-5',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '222:user:launch-owner-5',
        replyTarget: { channelId: '222' },
      },
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'fix the flaky auth test' }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(findFastReplySessionMock).not.toHaveBeenCalled();
  });

  it('/new opens a fresh conversation in a new topic when Telegram supports it', async () => {
    mockTelegramLinkedSender('launch-owner-5');
    createForumTopicMock.mockResolvedValueOnce({
      messageThreadId: '77',
      name: 'fix the flaky auth test',
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/new fix the flaky auth test',
          entities: [{ type: 'bot_command', offset: 0, length: 4 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastStartedNew: true,
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        threadId: '77',
        text: 'Request from Ada Lovelace:\n\nfix the flaky auth test',
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining('in a new topic'),
      }),
    );
    expect(getFastSessionMock).toHaveBeenCalledWith({
      userId: 'launch-owner-5',
      conversation: {
        surface: 'telegram',
        workspaceId: '222',
        conversationId: '77:user:launch-owner-5',
        replyTarget: { channelId: '222', threadId: '77' },
      },
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'fix the flaky auth test',
        currentMessageId: 'telegram-response',
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('/new starts a fresh conversation even while a task is running in the chat', async () => {
    mockTelegramLinkedSender('launch-owner-8');
    taskRunsFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/new start over',
          entities: [{ type: 'bot_command', offset: 0, length: 4 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastStartedNew: true,
    });
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'start over' }),
    );
  });

  it('replies with a usage hint for a bare /new with no description', async () => {
    mockTelegramLinkedSender('launch-owner-7');

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/new',
          entities: [{ type: 'bot_command', offset: 0, length: 4 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      repliedInline: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining('`/new fix the flaky auth test`'),
      }),
    );
  });

  it('queues a mid-sentence slash token as an ordinary follow-up', async () => {
    mockTelegramLinkedSender('launch-owner-9');
    taskRunsFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'check the /status route in the build',
          entities: [{ type: 'bot_command', offset: 10, length: 7 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      77,
      expect.objectContaining({
        userId: 'launch-owner-9',
        // The mid-sentence command is message content: delivered verbatim,
        // not spliced out of the follow-up text.
        text: 'check the /status route in the build',
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('starts a fresh conversation for a mention-prefixed /new in a group', async () => {
    mockTelegramLinkedSender('launch-owner-10');
    taskRunsFindFirstMock.mockResolvedValueOnce(null);

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '@roomote_bot /new fix the tests',
          chat: { id: -1007, type: 'group', title: 'Engineering' },
          entities: [
            { type: 'mention', offset: 0, length: 12 },
            { type: 'bot_command', offset: 13, length: 4 },
          ],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastStartedNew: true,
    });
    // A group without topics anchors the conversation on the command message.
    expect(getFastSessionMock).toHaveBeenCalledWith({
      userId: 'launch-owner-10',
      conversation: {
        surface: 'telegram',
        workspaceId: '-1007',
        conversationId: '456:user:launch-owner-10',
        replyTarget: { channelId: '-1007' },
      },
    });
    expect(continueFastReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'fix the tests' }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('welcomes bare /start commands without launching a task', async () => {
    mockTelegramLinkedSender();

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      welcomed: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringContaining("I'm Roomote"),
        textFormat: 'markdown',
      }),
    );
    const welcomeText = postMessageMock.mock.calls[0]?.[0].text as string;
    expect(welcomeText).toContain('*Available commands*');
    expect(welcomeText).toContain('`/start`');
    expect(welcomeText).toContain('`/new <request>`');
    expect(welcomeText).not.toContain('`/start <request>`');
  });

  it('welcomes bare /start commands from an unlinked sender', async () => {
    appendAccountLinkHelpTextMock.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );
    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      welcomed: true,
    });
    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    // An unlinked sender has no user to attribute the primary chat capture
    // to yet, so nothing should be persisted.
    expect(insertValuesMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TELEGRAM_PRIMARY_CHAT_ID' }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringContaining('Linked Accounts'),
        textFormat: 'markdown',
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0].text).toContain(
      'Ask an admin for an invite.',
    );
  });

  it('nudges unlinked senders to link their account in the /start welcome', async () => {
    await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Linked Accounts'),
      }),
    );
  });

  it('omits the link nudge from the /start welcome for linked senders', async () => {
    telegramMappingsFindFirstMock.mockResolvedValue({
      userId: 'linked-user-9',
    });
    usersFindFirstMock.mockResolvedValue({
      id: 'linked-user-9',
      deletedAt: null,
    });

    await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("I'm Roomote"),
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Linked Accounts'),
      }),
    );
  });

  it('captures the primary chat id for private messages', async () => {
    mockTelegramLinkedSender();

    await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TELEGRAM_PRIMARY_CHAT_ID',
        value: '222',
        createdByUserId: 'launch-owner-1',
      }),
    );
  });

  it('acknowledges suggestion clicks whose launch is already claimed', async () => {
    mockTelegramLinkedSender();
    updateReturningMock.mockResolvedValueOnce([]);

    const response = await postTelegramUpdate({
      update_id: 905,
      callback_query: {
        id: 'cb-6',
        from: { id: 111, first_name: 'Ada' },
        data: 'idea:9f6b1a2c-1111-2222-3333-444455556666',
        message: {
          message_id: 780,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-6',
        text: 'That idea was already started or is no longer available.',
      }),
    );
  });

  it('links the sender when a valid link code is sent to the bot', async () => {
    consumeLinkCodeMock.mockResolvedValueOnce('linked-user-9');

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: { text: 'link-abc123DEF456ghi7' },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      linked: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    // Mapping upsert + primary chat capture both insert.
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramUserId: '111',
        telegramChatId: '222',
        telegramUsername: 'ada',
        userId: 'linked-user-9',
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringMatching(
          /Linked![\s\S]*Available commands[\s\S]*\/start[\s\S]*\/new <request>/,
        ),
        textFormat: 'markdown',
      }),
    );
  });

  it('links via the /start deep-link payload', async () => {
    consumeLinkCodeMock.mockResolvedValueOnce('linked-user-9');

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start link-abc123DEF456ghi7',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      linked: true,
    });
    expect(consumeLinkCodeMock).toHaveBeenCalledWith('link-abc123DEF456ghi7');
  });

  it('rejects expired link codes with a helpful reply', async () => {
    consumeLinkCodeMock.mockResolvedValueOnce(null);

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: { text: 'link-abc123DEF456ghi7' },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      linked: false,
      reason: 'invalid_link_code',
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('invalid or has expired'),
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('restores the link code when storing the mapping fails', async () => {
    consumeLinkCodeMock.mockResolvedValueOnce('linked-user-9');
    insertOnConflictDoNothingMock.mockRejectedValueOnce(
      new Error('db unavailable'),
    );

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: { text: 'link-abc123DEF456ghi7' },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      linked: false,
      reason: 'link_error',
    });
    expect(restoreLinkCodeMock).toHaveBeenCalledWith(
      'link-abc123DEF456ghi7',
      'linked-user-9',
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Your code is still valid'),
      }),
    );
  });

  it('queues link-code-shaped follow-ups to an active task run instead of consuming them', async () => {
    mockTelegramLinkedSender();
    taskRunsFindFirstMock.mockResolvedValue({ id: 55 });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: { text: 'link-abc123DEF456ghi7' },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 55,
    });
    expect(consumeLinkCodeMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      55,
      expect.objectContaining({ text: 'link-abc123DEF456ghi7' }),
    );
  });

  it('attributes messages to the linked sender over the launch owner', async () => {
    telegramMappingsFindFirstMock.mockResolvedValueOnce({
      userId: 'linked-user-9',
    });
    usersFindFirstMock.mockResolvedValueOnce({
      id: 'linked-user-9',
      deletedAt: null,
    });
    taskRunsFindFirstMock.mockResolvedValueOnce({ id: 55 });

    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 55,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      55,
      expect.objectContaining({ userId: 'linked-user-9' }),
    );
    expect(setTrustedRunActingUserMock).toHaveBeenCalledWith({
      runId: 55,
      userId: 'linked-user-9',
    });
  });

  it('does not attribute a stale linked mapping that points at a removed user', async () => {
    telegramMappingsFindFirstMock.mockResolvedValueOnce({
      userId: 'linked-user-9',
    });
    usersFindFirstMock.mockResolvedValueOnce({
      id: 'linked-user-9',
      deletedAt: 'deletedAt',
    });

    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(telegramMappingsFindFirstMock).toHaveBeenCalledTimes(1);
    expect(usersFindFirstMock).toHaveBeenCalledTimes(1);
    expect(authUsersFindFirstMock).not.toHaveBeenCalled();
  });

  it('does not welcome /start when the sender only has a stale linked mapping', async () => {
    telegramMappingsFindFirstMock.mockResolvedValueOnce({
      userId: 'linked-user-9',
    });
    usersFindFirstMock.mockResolvedValueOnce({
      id: 'linked-user-9',
      deletedAt: 'deletedAt',
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      welcomed: true,
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Linked Accounts'),
      }),
    );
  });

  it('cancels the task run when a cancel_task callback button is clicked', async () => {
    taskRunsFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-42',
      status: 'running',
      sandboxServerUrl: null,
      userId: 'launch-owner-1',
      actingUserId: null,
    });
    stopTaskRunMock.mockResolvedValueOnce({ success: true });

    const response = await postTelegramUpdate({
      update_id: 900,
      callback_query: {
        id: 'cb-1',
        from: { id: 111, first_name: 'Ada' },
        data: 'cancel_task:42',
        message: {
          message_id: 777,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      callbackHandled: true,
    });
    expect(stopTaskRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: 42 }),
        allowDirectCancelWithoutSandbox: true,
        terminate: true,
      }),
    );
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-1',
        text: 'Task canceled.',
      }),
    );
    expect(editMessageReplyMarkupMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '222', messageId: '777' }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '777',
        text: 'Canceled the task.',
      }),
    );
  });

  it('scopes cancel lookups to the chat the button lives in', async () => {
    taskRunsFindFirstMock.mockResolvedValueOnce(undefined);

    await postTelegramUpdate({
      update_id: 903,
      callback_query: {
        id: 'cb-4',
        from: { id: 111, first_name: 'Ada' },
        data: 'cancel_task:42',
        message: {
          message_id: 779,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    const whereArg = taskRunsFindFirstMock.mock.calls[0]?.[0]?.where;
    expect(JSON.stringify(whereArg)).toContain('222');
  });

  it('only answers cancel callbacks that carry no originating message', async () => {
    const response = await postTelegramUpdate({
      update_id: 904,
      callback_query: {
        id: 'cb-5',
        from: { id: 111, first_name: 'Ada' },
        data: 'cancel_task:42',
      },
    });

    expect(response.status).toBe(200);
    expect(taskRunsFindFirstMock).not.toHaveBeenCalled();
    expect(stopTaskRunMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackQueryId: 'cb-5' }),
    );
  });

  it('acknowledges cancel clicks for jobs that are no longer running', async () => {
    taskRunsFindFirstMock.mockResolvedValueOnce(undefined);

    const response = await postTelegramUpdate({
      update_id: 901,
      callback_query: {
        id: 'cb-2',
        from: { id: 111, first_name: 'Ada' },
        data: 'cancel_task:42',
        message: {
          message_id: 778,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(stopTaskRunMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-2',
        text: 'That task is no longer running.',
      }),
    );
    expect(editMessageReplyMarkupMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '222', messageId: '778' }),
    );
  });

  it('answers and ignores unknown callback data', async () => {
    const response = await postTelegramUpdate({
      update_id: 902,
      callback_query: {
        id: 'cb-3',
        from: { id: 111, first_name: 'Ada' },
        data: 'mystery_action:1',
      },
    });

    expect(response.status).toBe(200);
    expect(stopTaskRunMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackQueryId: 'cb-3' }),
    );
  });
});
