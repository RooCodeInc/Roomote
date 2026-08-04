import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authAccountsFindFirstMock,
  authAccountsFindManyMock,
  authUsersFindFirstMock,
  buildTeamsRoutingContextMock,
  enqueueTaskMock,
  envMock,
  fetchMessageImageDataUrlsMock,
  findFirstMock,
  getTaskUrlMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertOnConflictDoUpdateMock,
  insertValuesMock,
  microsoftAuthUserMappingFindFirstMock,
  microsoftAuthUserMappingsTable,
  postDirectMessageMock,
  postMessageMock,
  processImageAttachmentsMock,
  redisEvalMock,
  redisGetMock,
  queueCommunicationMessageMock,
  redisSetMock,
  routeTaskMock,
  setTrustedRunActingUserMock,
  shouldRouteUnmentionedReplyMock,
  teamsInstallationsTable,
  teamsUserMappingsTable,
  teamsUserMappingFindFirstMock,
  usersFindFirstMock,
  verifyBotFrameworkJwtMock,
  withContentionMock,
  claimPendingOutOfBandMock,
  releaseClaimedOutOfBandMock,
  callViaEmojiConfigMock,
} = vi.hoisted(() => ({
  authAccountsFindFirstMock: vi.fn(),
  authAccountsFindManyMock: vi.fn(),
  authUsersFindFirstMock: vi.fn(),
  buildTeamsRoutingContextMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  envMock: {
    R_TEAMS_BOT_APP_ID: 'bot-app-id' as string | undefined,
    R_TEAMS_BOT_APP_PASSWORD: 'bot-secret' as string | undefined,
    R_TEAMS_BOT_TENANT_ID: undefined as string | undefined,
    R_TEAMS_BOT_TOKEN_ENDPOINT: undefined as string | undefined,
    R_TEAMS_BOT_OAUTH_SCOPE: undefined as string | undefined,
    R_APP_URL: 'https://app.example.com',
    R_MICROSOFT_CLIENT_ID: 'microsoft-client-id' as string | undefined,
    R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret' as string | undefined,
    R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id' as string | undefined,
    TRPC_URL: 'https://api.example.com',
  },
  fetchMessageImageDataUrlsMock: vi.fn(),
  findFirstMock: vi.fn(),
  getTaskUrlMock: vi.fn(() => 'https://app.example.com/task/task-new'),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertOnConflictDoUpdateMock: vi.fn(),
  insertValuesMock: vi.fn(),
  microsoftAuthUserMappingFindFirstMock: vi.fn(),
  microsoftAuthUserMappingsTable: {
    microsoftAadObjectId: 'microsoftAadObjectId',
    microsoftTenantId: 'microsoftTenantId',
  },
  postDirectMessageMock: vi.fn(),
  postMessageMock: vi.fn(),
  processImageAttachmentsMock: vi.fn(),
  redisEvalMock: vi.fn(),
  redisGetMock: vi.fn(),
  queueCommunicationMessageMock: vi.fn(),
  redisSetMock: vi.fn(),
  routeTaskMock: vi.fn(),
  setTrustedRunActingUserMock: vi.fn(),
  shouldRouteUnmentionedReplyMock: vi.fn(),
  teamsInstallationsTable: {
    installationKey: 'installationKey',
  },
  teamsUserMappingsTable: {
    teamsAadObjectId: 'teamsAadObjectId',
    teamsTenantId: 'teamsTenantId',
    teamsUserId: 'teamsUserId',
  },
  teamsUserMappingFindFirstMock: vi.fn(),
  usersFindFirstMock: vi.fn(),
  verifyBotFrameworkJwtMock: vi.fn(),
  withContentionMock: vi.fn(),
  claimPendingOutOfBandMock: vi.fn(),
  releaseClaimedOutOfBandMock: vi.fn(),
  callViaEmojiConfigMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: envMock,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    eval: redisEvalMock,
    get: redisGetMock,
    set: redisSetMock,
  })),
  withContention: withContentionMock,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  setTrustedRunActingUser: setTrustedRunActingUserMock,
  claimPendingOutOfBandTaskMessages: claimPendingOutOfBandMock,
  releaseClaimedOutOfBandTaskMessages: releaseClaimedOutOfBandMock,
  resolveTeamsBotRuntimeCredentials: vi.fn(async () => ({
    botAppId: envMock.R_TEAMS_BOT_APP_ID?.trim() || null,
    botAppPassword: envMock.R_TEAMS_BOT_APP_PASSWORD?.trim() || null,
    botTenantId: envMock.R_TEAMS_BOT_TENANT_ID?.trim() || null,
    botTokenEndpoint: envMock.R_TEAMS_BOT_TOKEN_ENDPOINT?.trim() || null,
    botOauthScope: envMock.R_TEAMS_BOT_OAUTH_SCOPE?.trim() || null,
    source:
      envMock.R_TEAMS_BOT_APP_ID && envMock.R_TEAMS_BOT_APP_PASSWORD
        ? 'teams_bot'
        : null,
  })),
  taskRuns: {
    payload: 'payload',
    status: 'status',
    canceledAt: 'canceledAt',
    createdAt: 'createdAt',
    snapshotId: 'snapshotId',
    snapshotCreatedAt: 'snapshotCreatedAt',
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
    // The Teams job lookups moved from db.query.taskRuns.findFirst to
    // db.select(...).from(taskRuns).innerJoin(tasks). Adapt the select chain
    // onto the same sequential findFirstMock queue so existing per-test row
    // sequences keep working; legacy `userId` keys map to run actingUserId.
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => {
          const row = (await findFirstMock()) as Record<string, unknown> | null;

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
        findFirst: authAccountsFindFirstMock,
        findMany: authAccountsFindManyMock,
      },
      authUsers: {
        findFirst: authUsersFindFirstMock,
      },

      environments: {
        findFirst: vi.fn(),
      },
      microsoftAuthUserMappings: {
        findFirst: microsoftAuthUserMappingFindFirstMock,
      },
      teamsUserMappings: {
        findFirst: teamsUserMappingFindFirstMock,
      },
      users: {
        findFirst: usersFindFirstMock,
      },
    },
  },
  desc: vi.fn((column: unknown) => ({ desc: column })),
  environments: {
    id: 'environmentId',
  },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({
    inArray: [column, values],
  })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings,
    values,
  })),
  authAccounts: {
    accountId: 'accountId',
    providerId: 'providerId',
  },
  authUsers: {
    id: 'authUserId',
  },
  microsoftAuthUserMappings: microsoftAuthUserMappingsTable,
  teamsInstallations: teamsInstallationsTable,
  teamsUserMappings: teamsUserMappingsTable,
  users: {
    deletedAt: 'deletedAt',
    id: 'userId',
  },
}));

vi.mock('@roomote/communication/messages', () => ({
  queueCommunicationMessage: queueCommunicationMessageMock,
}));

vi.mock('@roomote/communication/teams-provider', () => ({
  TeamsCommunicationProvider: vi.fn().mockImplementation(function () {
    return {
      postDirectMessage: postDirectMessageMock,
      postMessage: postMessageMock,
      fetchMessageImageDataUrls: fetchMessageImageDataUrlsMock,
      processImageAttachments: processImageAttachmentsMock,
    };
  }),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(async () =>
    envMock.R_TEAMS_BOT_APP_ID && envMock.R_TEAMS_BOT_APP_PASSWORD
      ? {
          postDirectMessage: postDirectMessageMock,
          postMessage: postMessageMock,
          fetchMessageImageDataUrls: fetchMessageImageDataUrlsMock,
          processImageAttachments: processImageAttachmentsMock,
        }
      : null,
  ),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildTeamsRoutingContext: buildTeamsRoutingContextMock,
  enqueueTask: enqueueTaskMock,
  getTaskUrl: getTaskUrlMock,
  routeTask: routeTaskMock,
}));

vi.mock('../bot-framework-auth.js', () => ({
  verifyBotFrameworkJwt: verifyBotFrameworkJwtMock,
}));

vi.mock('../unmentioned-thread-reply.js', () => ({
  shouldRouteUnmentionedTeamsThreadReplyToAgent:
    shouldRouteUnmentionedReplyMock,
}));

vi.mock('../../call-roomote-via-emoji.js', () => ({
  getCallRoomoteViaEmojiConfiguration: callViaEmojiConfigMock,
}));

import { teams } from '../index';

function createApp() {
  const app = new Hono();

  app.route('/teams', teams);

  return app;
}

function createTeamsActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: 'activity-2',
    text: '<at>Roomote</at> continue',
    from: {
      id: '29:user',
      name: 'Ada Lovelace',
      aadObjectId: 'aad-user-1',
    },
    channelId: 'msteams',
    conversation: {
      id: '19:conversation@thread.v2',
      tenantId: 'tenant-1',
      conversationType: 'channel',
    },
    recipient: {
      id: '28:bot',
      name: 'Roomote',
    },
    entities: [
      {
        type: 'mention',
        text: '<at>Roomote</at>',
        mentioned: {
          id: '28:bot',
          name: 'Roomote',
        },
      },
    ],
    replyToId: 'activity-root',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    ...overrides,
  };
}

function createJwtPayload(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    '',
  ].join('.');
}

describe('Teams webhook handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.R_TEAMS_BOT_APP_ID = 'bot-app-id';
    envMock.R_MICROSOFT_CLIENT_ID = 'microsoft-client-id';
    envMock.R_MICROSOFT_CLIENT_SECRET = 'microsoft-client-secret';
    envMock.R_MICROSOFT_TENANT_ID = 'microsoft-tenant-id';
    findFirstMock.mockResolvedValue({
      id: 77,
      status: 'running',
      machineId: 'machine-1',
      taskId: 'task-1',
      payload: {},
    });
    queueCommunicationMessageMock.mockResolvedValue(undefined);
    claimPendingOutOfBandMock.mockResolvedValue([]);
    releaseClaimedOutOfBandMock.mockResolvedValue(undefined);
    buildTeamsRoutingContextMock.mockResolvedValue({ context: true });
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
    postDirectMessageMock.mockResolvedValue({ messageId: 'dm-response' });
    postMessageMock.mockResolvedValue({ messageId: 'activity-response' });
    fetchMessageImageDataUrlsMock.mockResolvedValue([]);
    processImageAttachmentsMock.mockResolvedValue([
      'data:image/png;base64,abc123',
    ]);
    redisEvalMock.mockResolvedValue(null);
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
      onConflictDoUpdate: insertOnConflictDoUpdateMock,
    });
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    insertOnConflictDoUpdateMock.mockResolvedValue(undefined);
    teamsUserMappingFindFirstMock.mockResolvedValue(null);
    authAccountsFindFirstMock.mockResolvedValue(null);
    authUsersFindFirstMock.mockResolvedValue(null);
    microsoftAuthUserMappingFindFirstMock.mockResolvedValue(null);
    usersFindFirstMock.mockResolvedValue(null);
    verifyBotFrameworkJwtMock.mockResolvedValue({ payload: {} });
    shouldRouteUnmentionedReplyMock.mockResolvedValue(false);
    callViaEmojiConfigMock.mockResolvedValue(null);
    withContentionMock.mockImplementation(
      async (
        _key: string,
        options: { onAcquired: () => Promise<unknown> },
      ) => ({
        acquired: true,
        value: await options.onAcquired(),
      }),
    );
  });

  it('rejects Teams webhooks without a valid Bot Framework JWT', async () => {
    verifyBotFrameworkJwtMock.mockRejectedValueOnce(new Error('missing JWT'));
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'teams_webhook_unauthorized',
    });
    expect(response.status).toBe(401);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('turns a configured reaction into a thread message', async () => {
    callViaEmojiConfigMock.mockResolvedValue({
      emoji: 'thumbsup',
      prompt: 'Act on this\n\nAdditional instructions:\nPrioritize safety.',
    });

    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          type: 'messageReaction',
          id: 'reaction-1',
          text: undefined,
          entities: undefined,
          replyToId: 'activity-root',
          reactionsAdded: [{ type: 'like' }],
        }),
      ),
    });

    expect(response.status).toBe(200);
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      77,
      expect.objectContaining({
        provider: 'teams',
        text: 'Act on this Additional instructions: Prioritize safety.',
        ts: 'reaction-1',
        threadTs: 'activity-root',
      }),
    );
  });

  it('ignores reaction types outside the Teams native set', async () => {
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          type: 'messageReaction',
          id: 'reaction-unsupported',
          text: undefined,
          entities: undefined,
          replyToId: 'activity-root',
          reactionsAdded: [{ type: 'white_check_mark' }],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'reaction_not_configured',
    });
    expect(callViaEmojiConfigMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
  });

  it('queues Teams message activities for matching active task runs', async () => {
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(response.status).toBe(200);
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installationKey: 'tenant:tenant-1',
        tenantId: 'tenant-1',
        conversationId: '19:conversation@thread.v2',
        botAppId: 'bot-app-id',
        botUserId: '28:bot',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      }),
    );
    expect(insertOnConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'installationKey',
        set: expect.objectContaining({
          tenantId: 'tenant-1',
          conversationId: '19:conversation@thread.v2',
        }),
      }),
    );
    expect(redisSetMock).toHaveBeenCalledWith(
      'teams:activity:activity-2',
      '1',
      'EX',
      300,
      'NX',
    );
    expect(findFirstMock).toHaveBeenCalled();
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith('teams', 77, {
      provider: 'teams',
      text: 'continue',
      user: 'Ada Lovelace',
      userId: 'mapped-user-1',
      ts: 'activity-2',
      channel: '19:conversation@thread.v2',
      threadTs: 'activity-root',
    });
    expect(setTrustedRunActingUserMock).toHaveBeenCalledWith({
      runId: 77,
      userId: 'mapped-user-1',
    });
  });

  it('queues untagged Teams thread replies for matching active task runs using the root thread id', async () => {
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          id: 'activity-followup',
          text: 'keep going',
          entities: [],
          conversation: {
            id: '19:conversation@thread.v2;messageid=activity-root',
            tenantId: 'tenant-1',
            conversationType: 'channel',
          },
          replyToId: 'bot-reply-1',
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith('teams', 77, {
      provider: 'teams',
      text: 'keep going',
      user: 'Ada Lovelace',
      userId: 'mapped-user-1',
      ts: 'activity-followup',
      channel: '19:conversation@thread.v2;messageid=activity-root',
      threadTs: 'activity-root',
    });
  });

  it('ignores bot-authored Teams message activities before queueing or launching', async () => {
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          id: 'bot-activity-1',
          text: 'Started a task',
          entities: [],
          from: {
            id: '28:bot-app-id',
            name: 'Roomote',
          },
          recipient: {
            id: '29:user',
            name: 'Ada Lovelace',
          },
          conversation: {
            id: '19:conversation@thread.v2;messageid=activity-root',
            tenantId: 'tenant-1',
            conversationType: 'channel',
          },
          replyToId: 'activity-root',
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'bot_activity',
    });
    expect(insertMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('queues Teams image attachments for matching active task runs', async () => {
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          attachments: [
            {
              contentType: 'image/*',
              contentUrl:
                'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
            },
          ],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(processImageAttachmentsMock).toHaveBeenCalledWith(
      [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
        },
      ],
      { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
    );
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      77,
      expect.objectContaining({
        images: ['data:image/png;base64,abc123'],
      }),
    );
  });

  it('queues image-only Teams attachments for matching active task runs', async () => {
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          text: '<at>Roomote</at>',
          attachments: [
            {
              contentType: 'image/*',
              contentUrl:
                'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
            },
          ],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      77,
      expect.objectContaining({
        text: 'Image attachment',
        images: ['data:image/png;base64,abc123'],
      }),
    );
  });

  it('uses Teams Graph hosted content when Bot Framework image download yields no prompt images', async () => {
    processImageAttachmentsMock.mockResolvedValueOnce([]);
    fetchMessageImageDataUrlsMock.mockResolvedValueOnce([
      'data:image/png;base64,graph123',
    ]);
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          attachments: [
            {
              contentType: 'image/*',
              contentUrl:
                'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
            },
          ],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(fetchMessageImageDataUrlsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:conversation@thread.v2',
        messageId: 'activity-2',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        threadId: 'activity-root',
      }),
    );
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      77,
      expect.objectContaining({
        images: ['data:image/png;base64,graph123'],
      }),
    );
  });

  it('links Teams users to Microsoft auth accounts by AAD object ID', async () => {
    microsoftAuthUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'microsoft-user-1',
    });
    usersFindFirstMock.mockResolvedValueOnce({
      id: 'microsoft-user-1',
      deletedAt: null,
    });

    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(insertMock).toHaveBeenCalledWith(teamsUserMappingsTable);
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamsUserId: '29:user',
        teamsTenantId: 'tenant-1',
        teamsAadObjectId: 'aad-user-1',
        userId: 'microsoft-user-1',
      }),
    );
    expect(insertOnConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: ['teamsUserId', 'teamsTenantId'],
        set: expect.objectContaining({
          teamsAadObjectId: 'aad-user-1',
          userId: 'microsoft-user-1',
        }),
      }),
    );
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith('teams', 77, {
      provider: 'teams',
      text: 'continue',
      user: 'Ada Lovelace',
      userId: 'microsoft-user-1',
      ts: 'activity-2',
      channel: '19:conversation@thread.v2',
      threadTs: 'activity-root',
    });
    expect(setTrustedRunActingUserMock).toHaveBeenCalledWith({
      runId: 77,
      userId: 'microsoft-user-1',
    });
  });

  it('links Teams users through an indexed Microsoft provider account match', async () => {
    authAccountsFindFirstMock.mockResolvedValueOnce({
      userId: 'microsoft-user-1',
      accountId: 'aad-user-1',
      idToken: createJwtPayload({
        oid: 'aad-user-1',
        tid: 'tenant-1',
      }),
    });
    usersFindFirstMock.mockResolvedValueOnce({
      id: 'microsoft-user-1',
      deletedAt: null,
    });

    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(authAccountsFindManyMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      77,
      expect.objectContaining({
        userId: 'microsoft-user-1',
      }),
    );
  });

  it('creates missing product users idempotently before Teams account linking', async () => {
    microsoftAuthUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'microsoft-user-1',
    });
    usersFindFirstMock.mockResolvedValueOnce(null);
    authUsersFindFirstMock.mockResolvedValueOnce({
      id: 'microsoft-user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      image: 'https://example.com/ada.png',
    });

    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'microsoft-user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      }),
    );
    expect(insertOnConflictDoNothingMock).toHaveBeenCalledWith({
      target: 'userId',
    });
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      77,
      expect.objectContaining({
        userId: 'microsoft-user-1',
      }),
    );
  });

  it('verifies direct Bot Framework JWT authorization', async () => {
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 77,
    });
    expect(response.status).toBe(200);
    expect(verifyBotFrameworkJwtMock).toHaveBeenCalledWith({
      authorizationHeader: 'Bearer bot-framework-token',
      botAppId: 'bot-app-id',
      activityServiceUrl: 'https://smba.trafficmanager.net/amer/',
      activityChannelId: 'msteams',
    });
  });

  it('ignores duplicate Teams activities', async () => {
    redisSetMock.mockResolvedValueOnce(null);
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
  });

  it('starts a new Teams task when the bot is mentioned without an active task run', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      runId: 88,
    });
    expect(response.status).toBe(200);
    expect(buildTeamsRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'mapped-user-1',
        taskDescription: 'continue',
      }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            repo: '__all_repositories__',
            description: 'continue',
            communicationProvider: 'teams',
            communicationChannelId: '19:conversation@thread.v2',
            communicationThreadId: 'activity-root',
            communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
          }),
        }),
        initiator: { kind: 'user', userId: 'mapped-user-1' },
        workflow: 'standard',
        surface: 'teams',
        trigger: 'message',
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:conversation@thread.v2',
        replyToMessageId: 'activity-root',
        text: expect.stringContaining('Started a task'),
      }),
    );
  });

  it('starts new Teams tasks with image attachments as prompt images', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          attachments: [
            {
              contentType: 'image/*',
              contentUrl:
                'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
            },
          ],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      runId: 88,
    });
    expect(processImageAttachmentsMock).toHaveBeenCalledWith(
      [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
        },
      ],
      { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
    );
    expect(buildTeamsRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        images: ['data:image/png;base64,abc123'],
      }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'continue',
            images: ['data:image/png;base64,abc123'],
            communicationProvider: 'teams',
          }),
        }),
        initiator: { kind: 'user', userId: 'mapped-user-1' },
        workflow: 'standard',
        surface: 'teams',
        trigger: 'message',
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
  });

  it('starts new Teams tasks from image-only task-entry activities', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          text: '<at>Roomote</at>',
          attachments: [
            {
              contentType: 'image/*',
              contentUrl:
                'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
            },
          ],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      runId: 88,
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'Image attachment',
            images: ['data:image/png;base64,abc123'],
            communicationProvider: 'teams',
          }),
        }),
        initiator: { kind: 'user', userId: 'mapped-user-1' },
        workflow: 'standard',
        surface: 'teams',
        trigger: 'message',
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
  });

  it('prompts task-entry Teams users to link accounts before starting work', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'account_link_required',
    });
    expect(response.status).toBe(200);
    expect(buildTeamsRoutingContextMock).not.toHaveBeenCalled();
    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^teams:auth:/),
      expect.stringContaining('"activity"'),
      'EX',
      900,
    );
    expect(postDirectMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botName: 'Roomote',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        tenantId: 'tenant-1',
        text: expect.stringContaining(
          'link your Microsoft Teams and Roomote accounts',
        ),
        textFormat: 'markdown',
        userId: '29:user',
      }),
    );
    expect(postDirectMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('/api/teams/auth?state='),
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:conversation@thread.v2',
        replyToMessageId: 'activity-root',
        text: 'I sent you a DM to link your Microsoft Teams account.',
      }),
    );
  });

  it('does not post resumable Teams account-link tokens in channel fallback replies', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    postDirectMessageMock.mockRejectedValueOnce(new Error('dm failed'));

    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'account_link_required',
    });
    expect(response.status).toBe(200);
    expect(postDirectMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('/api/teams/auth?state='),
      }),
    );

    const publicReply = postMessageMock.mock.calls[0]?.[0] as {
      text?: string;
    };

    expect(publicReply).toMatchObject({
      channelId: '19:conversation@thread.v2',
      replyToMessageId: 'activity-root',
      text: expect.stringContaining(
        'I need to link your Microsoft Teams account before I can help.',
      ),
    });
    expect(publicReply.text).toContain('open a personal chat');
    expect(publicReply.text).not.toContain('/api/teams/auth');
    expect(publicReply.text).not.toContain('state=');
  });

  it('continues a pending Teams auth request after the Teams account is linked', async () => {
    const pendingActivity = createTeamsActivity({
      id: 'pending-activity-1',
      text: '<at>Roomote</at> run the tests',
      attachments: [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
        },
      ],
    });
    redisGetMock.mockResolvedValueOnce(
      JSON.stringify({
        activity: pendingActivity,
        createdAt: '2026-06-30T12:00:00.000Z',
      }),
    );
    redisEvalMock.mockResolvedValueOnce(
      JSON.stringify({
        activity: pendingActivity,
        createdAt: '2026-06-30T12:00:00.000Z',
      }),
    );
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const response = await createApp().request('/teams/auth/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'teams-auth-token-1' }),
    });

    await expect(response.json()).resolves.toEqual({
      success: true,
      status: 'started',
      runId: 88,
      taskId: 'task-new',
      taskUrl: 'https://app.example.com/task/task-new',
    });
    expect(response.status).toBe(200);
    expect(redisGetMock).toHaveBeenCalledWith('teams:auth:teams-auth-token-1');
    expect(redisEvalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del'"),
      1,
      'teams:auth:teams-auth-token-1',
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'run the tests',
            images: ['data:image/png;base64,abc123'],
            communicationProvider: 'teams',
            communicationChannelId: '19:conversation@thread.v2',
            communicationThreadId: 'activity-root',
          }),
        }),
        initiator: { kind: 'user', userId: 'mapped-user-1' },
        workflow: 'standard',
        surface: 'teams',
        trigger: 'message',
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
    expect(processImageAttachmentsMock).toHaveBeenCalledWith(
      [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
        },
      ],
      { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
    );
  });

  it('does not consume a pending Teams auth token before Microsoft auth links the account', async () => {
    redisGetMock.mockResolvedValueOnce(
      JSON.stringify({
        activity: createTeamsActivity({ id: 'pending-activity-2' }),
        createdAt: '2026-06-30T12:00:00.000Z',
      }),
    );

    const response = await createApp().request('/teams/auth/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'teams-auth-token-2' }),
    });

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'account_link_required',
    });
    expect(response.status).toBe(409);
    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).not.toHaveBeenCalled();
  });

  it('starts personal chat tasks without unstable activity thread metadata', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          id: 'personal-activity-1',
          text: 'run the tests',
          entities: [],
          replyToId: undefined,
          conversation: {
            id: 'a:personal-conversation',
            tenantId: 'tenant-1',
            conversationType: 'personal',
          },
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      runId: 88,
    });
    const { task } = enqueueTaskMock.mock.calls[0]?.[0] as {
      task: { payload: Record<string, unknown> };
    };
    expect(task.payload).toMatchObject({
      communicationProvider: 'teams',
      communicationChannelId: 'a:personal-conversation',
      communicationMessageId: 'personal-activity-1',
    });
    expect(task.payload).not.toHaveProperty('communicationThreadId');
    expect(task.payload).not.toHaveProperty('teamsThreadId');
    const reply = postMessageMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reply).toMatchObject({
      channelId: 'a:personal-conversation',
      text: expect.stringContaining('Started a task'),
    });
    expect(reply).not.toHaveProperty('replyToMessageId');
  });

  it('ignores channel messages without a bot mention when no active task run exists', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          text: 'just chatting',
          entities: [],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: 'not_task_entry',
    });
    expect(shouldRouteUnmentionedReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mappedUserId: null,
        botAppId: 'bot-app-id',
      }),
    );
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('starts a task for an unmentioned thread reply when the unmentioned-reply gate routes it', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    shouldRouteUnmentionedReplyMock.mockResolvedValueOnce(true);
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          text: 'sounds good, keep going',
          entities: [],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      started: true,
      runId: 88,
    });
    expect(response.status).toBe(200);
    expect(shouldRouteUnmentionedReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mappedUserId: 'mapped-user-1',
        botAppId: 'bot-app-id',
        activity: expect.objectContaining({ id: 'activity-2' }),
        metadata: expect.objectContaining({
          communicationProvider: 'teams',
          communicationThreadId: 'activity-root',
        }),
      }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'standard',
          payload: expect.objectContaining({
            description: 'sounds good, keep going',
            communicationProvider: 'teams',
          }),
        }),
        initiator: { kind: 'user', userId: 'mapped-user-1' },
        workflow: 'standard',
        surface: 'teams',
        trigger: 'message',
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
  });

  it('resumes a completed Teams task from a snapshot for an unmentioned thread reply the gate routes', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 77,
      userId: 'user-1',
      type: 'standard.task',
      status: 'completed',
      taskId: 'task-1',
      payload: { repo: 'org/repo', environmentId: 'env-1' },
      port: 3000,
      snapshotId: 'snap-1',
      snapshotCreatedAt: new Date(),
    });
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    shouldRouteUnmentionedReplyMock.mockResolvedValueOnce(true);
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        createTeamsActivity({
          text: 'sounds good, keep going',
          entities: [],
        }),
      ),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      resumed: true,
      runId: 88,
    });
    expect(response.status).toBe(200);
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'snapshot_resume',
          sourceSnapshotId: 'snap-1',
          sourceRunId: 77,
        }),
        actingUserId: 'mapped-user-1',
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
  });

  it('includes claimed out-of-band review context on Teams snapshot resume', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 77,
      userId: 'user-1',
      type: 'standard.task',
      status: 'completed',
      taskId: 'task-1',
      payload: { repo: 'org/repo', environmentId: 'env-1' },
      port: 3000,
      snapshotId: 'snap-1',
      snapshotCreatedAt: new Date(),
    });
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    claimPendingOutOfBandMock.mockResolvedValueOnce([
      {
        id: 'oob-1',
        ts: 1_720_000_000_000,
        text: 'I left two review comments on PR #42',
      },
    ]);

    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    expect(response.status).toBe(200);
    expect(claimPendingOutOfBandMock).toHaveBeenCalledWith('task-1');
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            queuedCommunicationMessages: [
              expect.objectContaining({
                formattedPrompt: expect.stringContaining(
                  'I left two review comments on PR #42',
                ),
              }),
            ],
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
  });

  it('resumes a completed Teams task from a snapshot when it wins the resume lock', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 77,
      userId: 'user-1',
      type: 'standard.task',
      status: 'completed',
      taskId: 'task-1',
      payload: { repo: 'org/repo', environmentId: 'env-1' },
      port: 3000,
      snapshotId: 'snap-1',
      snapshotCreatedAt: new Date(),
    });
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      resumed: true,
      runId: 88,
    });
    expect(response.status).toBe(200);
    expect(withContentionMock).toHaveBeenCalledWith(
      'teams:resume-lock:19:conversation@thread.v2:activity-root',
      expect.objectContaining({ ttlSeconds: 30 }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'snapshot_resume',
          sourceSnapshotId: 'snap-1',
          sourceRunId: 77,
        }),
        actingUserId: 'mapped-user-1',
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:conversation@thread.v2',
        replyToMessageId: 'activity-root',
      }),
    );
  });

  it('queues the follow-up to the leader resume task run when the resume lock is contended', async () => {
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 77,
        userId: 'user-1',
        type: 'standard.task',
        status: 'completed',
        taskId: 'task-1',
        payload: { repo: 'org/repo' },
        port: 3000,
        snapshotId: 'snap-1',
        snapshotCreatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 99,
        userId: 'user-1',
        type: 'snapshot.resume',
        status: 'running',
        taskId: 'task-resume',
        payload: {},
      });
    teamsUserMappingFindFirstMock.mockResolvedValueOnce({
      userId: 'mapped-user-1',
    });
    withContentionMock.mockImplementationOnce(
      async (
        _key: string,
        options: { onContended: () => Promise<unknown> },
      ) => ({ acquired: false, value: await options.onContended() }),
    );
    const response = await createApp().request('/teams', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bot-framework-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(createTeamsActivity()),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: true,
      runId: 99,
    });
    expect(response.status).toBe(200);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(queueCommunicationMessageMock).toHaveBeenCalledWith(
      'teams',
      99,
      expect.objectContaining({ provider: 'teams' }),
    );
  });
});
