import { Hono } from 'hono';
import { createHmac } from 'node:crypto';

import { ALL_REPOSITORIES, CloudAgentType } from '@roomote/types';

const {
  redisMock,
  emitThought,
  emitElicitation,
  updateSessionExternalUrls,
  createLinearAgentRun,
  findLinearDeploymentMcpConnectionByIdentityMock,
  findLinearUserMcpConnectionByIdentityMock,
  getValidAccessTokenMock,
  createMcpOauthReplayMock,
} = vi.hoisted(() => ({
  redisMock: {
    eval: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    sadd: vi.fn(),
  },
  emitThought: vi.fn().mockResolvedValue({ success: true }),
  emitElicitation: vi.fn().mockResolvedValue({ success: true }),
  updateSessionExternalUrls: vi.fn().mockResolvedValue({ success: true }),
  createLinearAgentRun: vi
    .fn()
    .mockResolvedValue({ status: 'ok', runId: 101, taskId: 'task-101' }),
  findLinearDeploymentMcpConnectionByIdentityMock: vi.fn(),
  findLinearUserMcpConnectionByIdentityMock: vi.fn(),
  getValidAccessTokenMock: vi.fn(),
  createMcpOauthReplayMock: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      LINEAR_WEBHOOK_SECRET: 'test-linear-secret',
      ROOMOTE_APP_URL: 'https://app.roomote.example',
      PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example',
      TRPC_URL: 'https://api.roomote.example',
    },
  };
});

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
  routeTask: vi.fn(),
  buildLinearRoutingContext: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/sdk/server')>();

  return {
    ...actual,
    findLinearDeploymentMcpConnectionByIdentity:
      findLinearDeploymentMcpConnectionByIdentityMock,
    findLinearUserMcpConnectionByIdentity:
      findLinearUserMcpConnectionByIdentityMock,
    getValidAccessToken: getValidAccessTokenMock,
    createMcpOauthReplay: createMcpOauthReplayMock,
  };
});

vi.mock('@roomote/feature-flags/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/feature-flags/server')>();

  return actual;
});

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => redisMock),
  REDIS_KEYS: {},
}));

vi.mock('@roomote/linear', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/linear')>();

  return {
    ...actual,
    verifyLinearWebhookSignature: vi.fn().mockReturnValue(true),
    isWebhookTimestampValid: vi.fn().mockReturnValue(true),
    parseAgentSessionEventPayload: vi
      .fn()
      .mockImplementation((data: unknown) => ({
        success: true,
        data,
      })),
    createLinearClient: vi.fn().mockReturnValue({
      emitThought,
      emitError: vi.fn().mockResolvedValue({ success: true }),
      emitResponse: vi.fn().mockResolvedValue({ success: true }),
      emitElicitation,
      updateSessionExternalUrl: vi.fn().mockResolvedValue(undefined),
      updateSessionExternalUrls,
    }),
    findActiveLinearTaskRun: vi.fn().mockResolvedValue(null),
    findCompletedLinearTaskRunWithSnapshot: vi.fn().mockResolvedValue(null),
    queueLinearMessage: vi.fn(),
    cancelLinearTaskRun: vi.fn(),
    getValidLinearAccessToken: vi.fn().mockResolvedValue('valid-token'),
    createLinearAgentRun,
    startElicitationFallback: vi.fn().mockResolvedValue({
      status: 'ok',
      pendingSelection: { step: 'awaiting_workspace' },
    }),
    findPendingSelection: vi.fn().mockResolvedValue(null),
    handleElicitationResponse: vi.fn(),
    deletePendingSelection: vi.fn(),
    enrichSessionComments: vi
      .fn()
      .mockImplementation((_client: unknown, session: unknown) => session),
  };
});

vi.mock('@roomote/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/types')>();
  return {
    ...original,
    buildPreviewProxyUrl: vi
      .fn()
      .mockReturnValue('https://preview.roomote.example/task-id'),
    DEFAULT_PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example',
  };
});

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      query: {},
    },
    linearInstallations: {
      linearOrganizationId: 'linearOrganizationId',
      isActive: 'isActive',
    },
    linearUserMappings: {
      linearUserId: 'linearUserId',
      linearOrganizationId: 'linearOrganizationId',
    },
    linearAuthTokens: {},
    webhooks: { id: 'id', deliveryId: 'deliveryId' },
    eq: vi.fn(),
    and: vi.fn(),
  };
});

vi.mock('../recordWebhook', () => ({
  recordLinearWebhook: vi.fn(
    async (
      _deliveryId: string,
      _event: string,
      _payload: unknown,
      handler: () => Promise<unknown>,
    ) => {
      await handler();
    },
  ),
}));

import {
  buildLinearRoutingContext,
  routeTask,
} from '@roomote/cloud-agents/server';
import { db } from '@roomote/db/server';
import { linear } from '../index';

function createSignedRequest(body: unknown) {
  const rawBody = JSON.stringify(body);

  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'linear-delivery': `delivery-${Date.now()}`,
      'linear-signature': createHmac('sha256', 'test-linear-secret')
        .update(rawBody)
        .digest('hex'),
    } as Record<string, string>,
  };
}

function createSelectResult<T>(rows: T[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: Date.now(),
    organizationId: 'linear-org-1',
    agentSession: {
      id: 'session-1',
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Review this PR',
        description: 'Need help reviewing',
      },
      creator: { id: 'linear-user-1' },
    },
    agentActivity: {
      content: { body: 'Please review this' },
    },
    ...overrides,
  };
}

function setupDbMocks() {
  vi.mocked(db.select).mockReturnValue(
    createSelectResult([]) as unknown as ReturnType<typeof db.select>,
  );
  findLinearDeploymentMcpConnectionByIdentityMock.mockResolvedValue({
    id: 'conn-org-1',
    authConfig: {
      linearOrganizationId: 'linear-org-1',
      linearOrganizationName: 'Linear Org',
      linearOrganizationUrlKey: 'linear-org',
      appUserId: 'linear-app-user',
    },
  });
  findLinearUserMcpConnectionByIdentityMock.mockResolvedValue({
    id: 'conn-user-1',
    userId: 'user-1',
    authConfig: {
      linearOrganizationId: 'linear-org-1',
      linearUserId: 'linear-user-1',
    },
  });
  getValidAccessTokenMock.mockResolvedValue('valid-token');
}

describe('linear routed task startup', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/linear', linear);
    vi.clearAllMocks();
    setupDbMocks();

    vi.mocked(buildLinearRoutingContext).mockResolvedValue({
      userId: 'user-1',
      taskDescription: 'Please review this',
      source: {
        type: 'linear',
        issueIdentifier: 'ENG-123',
        issueTitle: 'Review this PR',
      },
      availableAgents: [],
      availableEnvironments: [],
    } as never);
  });

  it('starts the routed task immediately without exposing the agent name', async () => {
    vi.mocked(routeTask).mockResolvedValue({
      status: 'routed',
      result: {
        agentType: CloudAgentType.PrReviewer,
        workspace: { type: 'all_repositories' },
        reasoning: 'Best fit for review work',
      },
    });

    const payload = makePayload();
    const { rawBody, headers } = createSignedRequest(payload);

    const response = await app.request(
      new Request('http://localhost/linear', {
        method: 'POST',
        headers,
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(emitThought).toHaveBeenCalledWith(
      'session-1',
      'Getting started...',
      true,
    );
    expect(emitThought).toHaveBeenCalledWith(
      'session-1',
      'Getting started on your task in `all repos`',
      true,
    );
    expect(createLinearAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        repo: ALL_REPOSITORIES,
        environmentId: undefined,
      }),
    );
    expect(updateSessionExternalUrls).toHaveBeenCalledWith('session-1', [
      {
        label: 'Open task',
        url: 'https://app.roomote.example/task/task-101',
      },
    ]);
    expect(emitElicitation).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});
