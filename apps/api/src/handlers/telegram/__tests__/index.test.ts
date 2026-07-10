import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addReactionMock,
  answerCallbackQueryMock,
  authUsersFindFirstMock,
  buildTelegramRoutingContextMock,
  cloudJobsFindFirstMock,
  consumeLinkCodeMock,
  restoreLinkCodeMock,
  editMessageReplyMarkupMock,
  editMessageTextMock,
  enqueueTaskMock,
  environmentsFindFirstMock,
  envMock,
  getAvailableEnvironmentsMock,
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
  routeTaskMock,
  setLatestInboundMessageIdMock,
  stopTaskJobMock,
  updateMock,
  updateReturningMock,
  usersFindFirstMock,
  telegramMappingsFindFirstMock,
} = vi.hoisted(() => ({
  addReactionMock: vi.fn(),
  answerCallbackQueryMock: vi.fn(),
  authUsersFindFirstMock: vi.fn(),
  buildTelegramRoutingContextMock: vi.fn(),
  cloudJobsFindFirstMock: vi.fn(),
  consumeLinkCodeMock: vi.fn(),
  restoreLinkCodeMock: vi.fn(),
  editMessageReplyMarkupMock: vi.fn(),
  editMessageTextMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  environmentsFindFirstMock: vi.fn(),
  getAvailableEnvironmentsMock: vi.fn(),
  envMock: {
    ROOMOTE_APP_URL: 'https://app.example.com',
    TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
    TELEGRAM_BOT_USERNAME: 'roomote_bot' as string | undefined,
    TELEGRAM_WEBHOOK_SECRET: 'secret' as string | undefined,
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
  routeTaskMock: vi.fn(),
  setLatestInboundMessageIdMock: vi.fn(),
  stopTaskJobMock: vi.fn(),
  updateMock: vi.fn(),
  updateReturningMock: vi.fn(),
  usersFindFirstMock: vi.fn(),
  telegramMappingsFindFirstMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: envMock,
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
    // The Telegram job lookups moved from db.query.cloudJobs.findFirst to
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
          const row = (await cloudJobsFindFirstMock()) as Record<
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
        findFirst: cloudJobsFindFirstMock,
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
    botToken: envMock.TELEGRAM_BOT_TOKEN ?? null,
    webhookSecret: envMock.TELEGRAM_WEBHOOK_SECRET ?? null,
    botUsername: envMock.TELEGRAM_BOT_USERNAME ?? null,
  })),
}));

vi.mock('@roomote/communication/messages', () => ({
  queueCommunicationMessage: queueCommunicationMessageMock,
  setLatestInboundMessageId: setLatestInboundMessageIdMock,
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueTelegramSuggestedTasksOnboardingFollowup: vi.fn(),
  consumeTelegramLinkCode: consumeLinkCodeMock,
  restoreTelegramLinkCode: restoreLinkCodeMock,
  isTelegramLinkCode: (value: string) =>
    /^link-[A-Za-z0-9_-]{16,}$/.test(value.trim()),
  findTelegramPrimaryChatId: vi.fn(async () => null),
  TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME: 'TELEGRAM_PRIMARY_CHAT_ID',
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
    return {
      addReaction: addReactionMock,
      answerCallbackQuery: answerCallbackQueryMock,
      editMessageReplyMarkup: editMessageReplyMarkupMock,
      editMessageText: editMessageTextMock,
      postMessage: postMessageMock,
    };
  }),
}));

vi.mock('../../tasks/task-stop.js', () => ({
  stopTaskJob: stopTaskJobMock,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildTelegramRoutingContext: buildTelegramRoutingContextMock,
  enqueueTask: enqueueTaskMock,
  getAvailableEnvironments: getAvailableEnvironmentsMock,
  getTaskUrl: getTaskUrlMock,
  routeTask: routeTaskMock,
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

    // Some tests queue one-shot lookup results on these mocks. Reset them so
    // later tests do not inherit stale values when the whole suite runs.
    authUsersFindFirstMock.mockReset();
    usersFindFirstMock.mockReset();
    cloudJobsFindFirstMock.mockReset();
    telegramMappingsFindFirstMock.mockReset();
    consumeLinkCodeMock.mockReset();

    envMock.ROOMOTE_APP_URL = 'https://app.example.com';
    envMock.TELEGRAM_BOT_TOKEN = 'bot-token';
    envMock.TELEGRAM_BOT_USERNAME = 'roomote_bot';
    envMock.TELEGRAM_WEBHOOK_SECRET = 'secret';
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
    cloudJobsFindFirstMock.mockResolvedValue(null);
    telegramMappingsFindFirstMock.mockResolvedValue(null);
    consumeLinkCodeMock.mockResolvedValue(null);
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
    buildTelegramRoutingContextMock.mockResolvedValue({ context: true });
    routeTaskMock.mockResolvedValue({
      status: 'routed',
      result: {
        workspace: { type: 'all_repositories' },
        reasoning: 'all repos',
      },
    });
    enqueueTaskMock.mockResolvedValue({
      id: 88,
      taskId: 'task-new',
    });
    postMessageMock.mockResolvedValue({ messageId: 'telegram-response' });
  });

  it('nudges an unlinked sender to link and drops the message', async () => {
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
    expect(cloudJobsFindFirstMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringContaining('Linked Accounts'),
        textFormat: 'markdown',
      }),
    );
  });

  it('nudges an unlinked group sender who addressed the bot with a deep-link button', async () => {
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
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(routeTaskMock).not.toHaveBeenCalled();
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
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(routeTaskMock).not.toHaveBeenCalled();
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

  it('queues active-job messages for a linked sender', async () => {
    mockTelegramLinkedSender();
    cloudJobsFindFirstMock.mockResolvedValueOnce({
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
      cloudJobId: 77,
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
  });

  it('starts new Telegram tasks as the linked sender', async () => {
    mockTelegramLinkedSender('launch-owner-2');
    cloudJobsFindFirstMock
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
      started: true,
      cloudJobId: 88,
    });
    expect(response.status).toBe(200);
    expect(buildTelegramRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'launch-owner-2',
        taskDescription: 'please check this',
      }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            repo: '__all_repositories__',
            description: 'please check this',
            communicationProvider: 'telegram',
            communicationChannelId: '222',
            communicationMessageId: '456',
          }),
        }),
        initiator: { kind: 'user', userId: 'launch-owner-2' },
        workflow: 'standard',
        surface: 'telegram',
        trigger: 'message',
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining('Started a task'),
      }),
    );
    const postedCall = postMessageMock.mock.calls[0]![0] as {
      text: string;
      buttons?: { text: string; url?: string; callbackData?: string }[][];
    };
    expect(postedCall.text).not.toContain(
      'https://app.example.com/task/task-new',
    );
    expect(postedCall.buttons).toEqual([
      [{ text: 'Follow Task', url: 'https://app.example.com/task/task-new' }],
      [
        {
          text: '✖️ Cancel task',
          callbackData: expect.any(String),
        },
      ],
    ]);
  });

  it('replies inline when Telegram routing returns a platform answer', async () => {
    mockTelegramLinkedSender('launch-owner-3');
    cloudJobsFindFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    routeTaskMock.mockResolvedValueOnce({
      status: 'platform_answer',
      result: {
        answer: 'Try opening the task in the web app instead.',
      },
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/start help',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      repliedInline: true,
    });
    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: 'Try opening the task in the web app instead.',
      }),
    );
  });

  it('resumes a completed Telegram snapshot before starting a new task', async () => {
    mockTelegramLinkedSender('launch-owner-4');
    cloudJobsFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
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
      cloudJobId: 99,
    });
    expect(response.status).toBe(200);
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'launch-owner-4',
        task: expect.objectContaining({
          type: 'snapshot_resume',
          sourceSnapshotId: 'snapshot-1',
          sourceCloudJobId: 55,
          payload: expect.objectContaining({
            repo: 'RooCodeInc/Roomote',
            environmentId: 'env-1',
            port: 3000,
            sourceSnapshotId: 'snapshot-1',
            sourceCloudJobId: 55,
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

  it('/new bypasses a resumable snapshot and starts a fresh task', async () => {
    mockTelegramLinkedSender('launch-owner-5');
    // First findFirst: active-job lookup (none). Second findFirst: completed
    // snapshot lookup would normally resume, but /new skips it entirely.
    cloudJobsFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
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
      started: true,
      cloudJobId: 88,
    });
    expect(response.status).toBe(200);
    // A fresh StandardTask is enqueued, not a snapshot.resume.
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'fix the flaky auth test',
            communicationProvider: 'telegram',
            communicationChannelId: '222',
            communicationMessageId: '456',
          }),
        }),
        initiator: { kind: 'user', userId: 'launch-owner-5' },
        workflow: 'standard',
        surface: 'telegram',
        trigger: 'message',
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
    expect(routeTaskMock).toHaveBeenCalled();
  });

  it('/done works as an alias for /new', async () => {
    mockTelegramLinkedSender('launch-owner-6');
    cloudJobsFindFirstMock.mockResolvedValueOnce(null);

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/done run the test suite',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      cloudJobId: 88,
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'run the test suite',
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'human' }),
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
    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining('`/new fix the flaky auth test`'),
      }),
    );
  });

  it('refuses /new while a task is already running in the chat', async () => {
    mockTelegramLinkedSender('launch-owner-8');
    cloudJobsFindFirstMock.mockResolvedValueOnce({
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
      queued: false,
      repliedInline: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '456',
        text: expect.stringContaining('already running'),
      }),
    );
  });

  it('names the command sent and echoes the request in the refusal', async () => {
    mockTelegramLinkedSender('launch-owner-8');
    cloudJobsFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: '/done update the README instead',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      repliedInline: true,
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('/done update the README instead'),
      }),
    );
  });

  it('queues a mid-sentence /done as an ordinary follow-up to the active task', async () => {
    mockTelegramLinkedSender('launch-owner-9');
    cloudJobsFindFirstMock.mockResolvedValueOnce({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: {
          text: 'ping me when you are /done with the build',
          entities: [{ type: 'bot_command', offset: 21, length: 5 }],
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      cloudJobId: 77,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      77,
      expect.objectContaining({
        userId: 'launch-owner-9',
        // The mid-sentence command is message content: delivered verbatim,
        // not spliced out of the follow-up text.
        text: 'ping me when you are /done with the build',
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('starts a fresh task for a mention-prefixed /new in a group', async () => {
    mockTelegramLinkedSender('launch-owner-10');
    cloudJobsFindFirstMock.mockResolvedValueOnce(null);

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
      started: true,
      cloudJobId: 88,
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'fix the tests',
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
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
  });

  it('welcomes bare /start commands from an unlinked sender', async () => {
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
        text: expect.stringContaining('Linked!'),
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

  it('queues link-code-shaped follow-ups to an active job instead of consuming them', async () => {
    mockTelegramLinkedSender();
    cloudJobsFindFirstMock.mockResolvedValue({ id: 55 });

    const response = await postTelegramUpdate(
      createTelegramUpdate({
        message: { text: 'link-abc123DEF456ghi7' },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      cloudJobId: 55,
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
    cloudJobsFindFirstMock.mockResolvedValueOnce({ id: 55 });

    const response = await postTelegramUpdate(createTelegramUpdate());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      cloudJobId: 55,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'telegram',
      55,
      expect.objectContaining({ userId: 'linked-user-9' }),
    );
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

  it('cancels the cloud job when a cancel_task callback button is clicked', async () => {
    cloudJobsFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-42',
      status: 'running',
      sandboxServerUrl: null,
      userId: 'launch-owner-1',
      actingUserId: null,
    });
    stopTaskJobMock.mockResolvedValueOnce({ success: true });

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
    expect(stopTaskJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: 42 }),
        allowDirectCancelWithoutSandbox: true,
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
    cloudJobsFindFirstMock.mockResolvedValueOnce(undefined);

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

    const whereArg = cloudJobsFindFirstMock.mock.calls[0]?.[0]?.where;
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
    expect(cloudJobsFindFirstMock).not.toHaveBeenCalled();
    expect(stopTaskJobMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackQueryId: 'cb-5' }),
    );
  });

  it('acknowledges cancel clicks for jobs that are no longer running', async () => {
    cloudJobsFindFirstMock.mockResolvedValueOnce(undefined);

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
    expect(stopTaskJobMock).not.toHaveBeenCalled();
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
    expect(stopTaskJobMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackQueryId: 'cb-3' }),
    );
  });

  it('posts a routing confirmation with workspace options when the router is unsure', async () => {
    mockTelegramLinkedSender('launch-owner-20');
    getAvailableEnvironmentsMock.mockResolvedValue([
      { id: 'env-1', name: 'Web App', repositoryNames: ['org/web'] },
      { id: 'env-2', name: 'API', repositoryNames: ['org/api'] },
    ]);
    routeTaskMock.mockResolvedValueOnce({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-1', name: 'Web App' },
        reasoning: 'weak guess',
        debug: { confidence: 0.6 },
      },
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({ message: { text: 'fix the login bug' } }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      confirmationPending: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        text: expect.stringContaining('Planning to run this in **Web App**'),
        // Compact Yes/Nope card — the workspace list only appears after Nope.
        buttons: [
          [
            expect.objectContaining({
              text: '✅ Yes',
              callbackData: expect.stringMatching(/^route_ok:[\w-]+$/),
            }),
            expect.objectContaining({
              text: '✖️ Nope',
              callbackData: expect.stringMatching(/^route_alt:[\w-]+$/),
            }),
          ],
        ],
      }),
    );
    // The pending decision is stashed in Redis for the button callbacks.
    expect(redisSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^telegram:pending_route:[\w-]+$/),
      expect.stringContaining('"launchOwnerUserId":"launch-owner-20"'),
      'EX',
      expect.any(Number),
    );
  });

  it('asks for a workspace instead of defaulting to all repos when routing falls back', async () => {
    mockTelegramLinkedSender('launch-owner-21');
    getAvailableEnvironmentsMock.mockResolvedValue([
      { id: 'env-1', name: 'Web App', repositoryNames: ['org/web'] },
    ]);
    routeTaskMock.mockResolvedValueOnce({
      status: 'fallback',
      reason: 'router timeout',
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({ message: { text: 'fix the login bug' } }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      confirmationPending: true,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('could not confidently pick a workspace'),
        buttons: [
          [expect.objectContaining({ text: 'Web App' })],
          [expect.objectContaining({ text: 'All repositories' })],
          [expect.objectContaining({ text: '✖️ Nevermind' })],
        ],
      }),
    );
  });

  it('launches immediately when routing confidence is high', async () => {
    mockTelegramLinkedSender('launch-owner-22');
    getAvailableEnvironmentsMock.mockResolvedValue([
      { id: 'env-1', name: 'Web App', repositoryNames: ['org/web'] },
      { id: 'env-2', name: 'API', repositoryNames: ['org/api'] },
    ]);
    environmentsFindFirstMock.mockResolvedValueOnce({
      id: 'env-1',
      name: 'Web App',
      config: { repositories: [{ repository: 'org/web' }] },
    });
    routeTaskMock.mockResolvedValueOnce({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-1', name: 'Web App' },
        reasoning: 'clear match',
        debug: { confidence: 0.98 },
      },
    });

    const response = await postTelegramUpdate(
      createTelegramUpdate({ message: { text: 'fix the login bug' } }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      cloudJobId: 88,
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'org/web',
            environmentId: 'env-1',
          }),
        }),
      }),
      { launchClass: 'human' },
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Started a task in Web App.',
      }),
    );
  });

  it('launches the suggested workspace when the confirmation OK button is clicked', async () => {
    mockTelegramLinkedSender('launch-owner-23');
    const pending = JSON.stringify({
      launchOwnerUserId: 'launch-owner-23',
      queuedMessage: {
        provider: 'telegram',
        text: 'fix the login bug',
        user: 'Ada Lovelace',
        userId: 'launch-owner-23',
        ts: '456',
        channel: '222',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '222',
        communicationMessageId: '456',
      },
      options: [
        {
          label: 'Web App',
          workspace: { type: 'environment', id: 'env-1', name: 'Web App' },
        },
        { label: 'All repositories', workspace: { type: 'all_repositories' } },
      ],
      suggestedIndex: 0,
      confirmMessageId: '990',
    });
    redisGetMock.mockResolvedValue(pending);
    redisGetdelMock.mockResolvedValue(pending);
    environmentsFindFirstMock.mockResolvedValueOnce({
      id: 'env-1',
      name: 'Web App',
      config: { repositories: [{ repository: 'org/web' }] },
    });

    const response = await postTelegramUpdate({
      update_id: 910,
      callback_query: {
        id: 'cb-10',
        from: { id: 111, first_name: 'Ada' },
        data: 'route_ok:abc123XYZ789',
        message: {
          message_id: 990,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(redisGetdelMock).toHaveBeenCalledWith(
      'telegram:pending_route:abc123XYZ789',
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'launch-owner-23' },
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'org/web',
            environmentId: 'env-1',
            description: 'fix the login bug',
          }),
        }),
      }),
      { launchClass: 'human' },
    );
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-10',
        text: 'Starting in Web App.',
      }),
    );
    // The card is finalized in place: text swapped, keyboard removed.
    expect(editMessageTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        messageId: '990',
        text: 'Starting in **Web App**.',
      }),
    );
  });

  it('swaps the card into the workspace picker when Nope is clicked', async () => {
    mockTelegramLinkedSender('launch-owner-26');
    const pending = JSON.stringify({
      launchOwnerUserId: 'launch-owner-26',
      queuedMessage: {
        provider: 'telegram',
        text: 'fix the login bug',
        user: 'Ada Lovelace',
        userId: 'launch-owner-26',
        ts: '456',
        channel: '222',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '222',
        communicationMessageId: '456',
      },
      options: [
        {
          label: 'Web App',
          workspace: { type: 'environment', id: 'env-1', name: 'Web App' },
        },
        { label: 'All repositories', workspace: { type: 'all_repositories' } },
      ],
      suggestedIndex: 0,
      confirmMessageId: '995',
    });
    redisGetMock.mockResolvedValue(pending);
    redisGetdelMock.mockResolvedValue(pending);

    const response = await postTelegramUpdate({
      update_id: 914,
      callback_query: {
        id: 'cb-14',
        from: { id: 111, first_name: 'Ada' },
        data: 'route_alt:abc123XYZ789',
        message: {
          message_id: 995,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    // Same message becomes the picker, keyed by a fresh pending-route id so
    // the old auto-confirm timer can never fire the suggestion.
    expect(editMessageTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        messageId: '995',
        text: 'Okay — where should I run this?',
        buttons: [
          [
            expect.objectContaining({
              text: 'Web App',
              callbackData: expect.stringMatching(/^route_pick:[\w-]+:0$/),
            }),
          ],
          [
            expect.objectContaining({
              text: 'All repositories',
              callbackData: expect.stringMatching(/^route_pick:[\w-]+:1$/),
            }),
          ],
          [
            expect.objectContaining({
              text: '✖️ Nevermind',
              callbackData: expect.stringMatching(/^route_no:[\w-]+$/),
            }),
          ],
        ],
      }),
    );
    const editCall = editMessageTextMock.mock.calls[0]![0] as {
      buttons: Array<Array<{ callbackData: string }>>;
    };
    expect(editCall.buttons[0]![0]!.callbackData).not.toContain('abc123XYZ789');
    // The picker state was re-stored under the new id.
    expect(redisSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^telegram:pending_route:[\w-]+$/),
      expect.stringContaining('"suggestedIndex":null'),
      'EX',
      expect.any(Number),
    );
  });

  it('rejects confirmation clicks from someone other than the requester without consuming the choice', async () => {
    mockTelegramLinkedSender('someone-else');
    redisGetMock.mockResolvedValue(
      JSON.stringify({
        launchOwnerUserId: 'launch-owner-24',
        queuedMessage: {
          provider: 'telegram',
          text: 'fix it',
          user: 'Ada',
          userId: 'launch-owner-24',
          ts: '456',
          channel: '222',
        },
        metadata: {
          communicationProvider: 'telegram',
          communicationChannelId: '222',
          communicationMessageId: '456',
        },
        options: [
          {
            label: 'All repositories',
            workspace: { type: 'all_repositories' },
          },
        ],
        suggestedIndex: 0,
      }),
    );

    const response = await postTelegramUpdate({
      update_id: 911,
      callback_query: {
        id: 'cb-11',
        from: { id: 999, first_name: 'Mallory' },
        data: 'route_ok:abc123XYZ789',
        message: {
          message_id: 991,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(redisGetdelMock).not.toHaveBeenCalledWith(
      'telegram:pending_route:abc123XYZ789',
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-11',
        text: 'Only the requester can choose a workspace for this task.',
      }),
    );
  });

  it('acknowledges expired confirmation clicks and clears the stale buttons', async () => {
    redisGetMock.mockResolvedValue(null);

    const response = await postTelegramUpdate({
      update_id: 912,
      callback_query: {
        id: 'cb-12',
        from: { id: 111, first_name: 'Ada' },
        data: 'route_pick:abc123XYZ789:1',
        message: {
          message_id: 992,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-12',
        text: 'This choice expired — send the request again.',
      }),
    );
    expect(editMessageReplyMarkupMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '222', messageId: '992' }),
    );
  });

  it('dismisses the confirmation without launching when Nevermind is clicked', async () => {
    mockTelegramLinkedSender('launch-owner-25');
    const pending = JSON.stringify({
      launchOwnerUserId: 'launch-owner-25',
      queuedMessage: {
        provider: 'telegram',
        text: 'fix it',
        user: 'Ada',
        userId: 'launch-owner-25',
        ts: '456',
        channel: '222',
      },
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: '222',
        communicationMessageId: '456',
      },
      options: [
        { label: 'All repositories', workspace: { type: 'all_repositories' } },
      ],
      suggestedIndex: 0,
    });
    redisGetMock.mockResolvedValue(pending);
    redisGetdelMock.mockResolvedValue(pending);

    const response = await postTelegramUpdate({
      update_id: 913,
      callback_query: {
        id: 'cb-13',
        from: { id: 111, first_name: 'Ada' },
        data: 'route_no:abc123XYZ789',
        message: {
          message_id: 993,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackQueryId: 'cb-13',
        text: 'Okay — not starting a task.',
      }),
    );
    expect(editMessageTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        messageId: '993',
        text: 'Okay — not starting a task.',
      }),
    );
  });
});
