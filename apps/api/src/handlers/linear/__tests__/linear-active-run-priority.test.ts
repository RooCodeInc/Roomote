// pnpm --filter @roomote/api test src/handlers/linear/__tests__/linear-active-run-priority.test.ts
//
// CLO-1133: When a job is active and waiting on ask_followup_question, user
// replies must be delivered to the running job via queueLinearMessage. A stale
// routing confirmation key in Redis or a pending elicitation selection must NOT
// intercept the message.

import { Hono } from 'hono';
import { createHmac } from 'node:crypto';

// ── Mocks ──────────────────────────────────────────────────────────────

const { createLinearAgentRunMock } = vi.hoisted(() => ({
  createLinearAgentRunMock: vi
    .fn()
    .mockResolvedValue({ status: 'ok', runId: 77, taskId: 'task-77' }),
}));

const {
  findLinearDeploymentMcpConnectionByIdentityMock,
  findLinearUserMcpConnectionByIdentityMock,
  getValidAccessTokenMock,
  createMcpOauthReplayMock,
} = vi.hoisted(() => ({
  findLinearDeploymentMcpConnectionByIdentityMock: vi.fn(),
  findLinearUserMcpConnectionByIdentityMock: vi.fn(),
  getValidAccessTokenMock: vi.fn(),
  createMcpOauthReplayMock: vi.fn(),
}));

const { setTrustedRunActingUserOnSuccessMock } = vi.hoisted(() => ({
  setTrustedRunActingUserOnSuccessMock: vi.fn(
    async ({ operation }: { operation: () => Promise<boolean> }) =>
      await operation(),
  ),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      LINEAR_WEBHOOK_SECRET: 'test-linear-secret',
      ROOMOTE_APP_URL: 'https://app.roomote.example',
      PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example',
    },
  };
});

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
  routeTask: vi.fn(),
  buildLinearRoutingContext: vi.fn(),
  AGENT_TYPE_TO_PROMPT_NAME: {},
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

const redisMock = {
  eval: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  get: vi.fn().mockResolvedValue(null),
  sadd: vi.fn(),
};

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
      emitThought: vi.fn().mockResolvedValue({ success: true }),
      emitError: vi.fn().mockResolvedValue({ success: true }),
      emitResponse: vi.fn().mockResolvedValue({ success: true }),
      emitElicitation: vi.fn().mockResolvedValue({ success: true }),
      updateSessionExternalUrl: vi.fn().mockResolvedValue(undefined),
      updateSessionExternalUrls: vi.fn().mockResolvedValue(undefined),
    }),
    findActiveLinearTaskRun: vi.fn().mockResolvedValue(null),
    findCompletedLinearTaskRunWithSnapshot: vi.fn().mockResolvedValue(null),
    getPendingLinearRequestUserInput: vi.fn().mockResolvedValue(null),
    clearPendingLinearRequestUserInput: vi.fn().mockResolvedValue(true),
    markPendingLinearRequestUserInputSubmitted: vi.fn().mockResolvedValue(true),
    queueLinearMessage: vi.fn(),
    queueLinearRequestUserInputAnswer: vi.fn(),
    cancelLinearTaskRun: vi.fn(),
    getValidLinearAccessToken: vi.fn().mockResolvedValue('valid-token'),
    createLinearAgentRun: createLinearAgentRunMock,
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
    setTrustedRunActingUserOnSuccess: setTrustedRunActingUserOnSuccessMock,
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
  createLinearAgentRun,
  findActiveLinearTaskRun,
  getPendingLinearRequestUserInput,
  markPendingLinearRequestUserInputSubmitted,
  queueLinearMessage,
  queueLinearRequestUserInputAnswer,
  findPendingSelection,
  deletePendingSelection,
} from '@roomote/linear';
import { routeTask } from '@roomote/cloud-agents/server';
import { db } from '@roomote/db/server';
import { linear } from '../index';

// ── Helpers ────────────────────────────────────────────────────────────

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
    action: 'prompted',
    webhookTimestamp: Date.now(),
    organizationId: 'linear-org-1',
    agentSession: {
      id: 'session-1',
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix the bug',
        description: 'Something is broken',
      },
      creator: { id: 'linear-user-1' },
    },
    agentActivity: {
      content: { body: 'my custom free-text reply' },
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

// ── Tests ──────────────────────────────────────────────────────────────

describe('CLO-1133: active task run takes priority over routing confirmation and elicitation', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/linear', linear);
    vi.clearAllMocks();
  });

  it('delivers free-text reply to active task run even when routing confirmation key exists in Redis', async () => {
    setupDbMocks();

    // Simulate a stale routing confirmation key in Redis
    redisMock.eval.mockResolvedValue(
      JSON.stringify({
        agentName: 'Agent',
        agentType: 'Agent',
        workspaceSelection: { repo: 'owner/repo' },
        workspaceDisplayName: 'owner/repo',
        workspaceType: 'repository',
        linearOrganizationId: 'linear-org-1',
        userId: 'user-1',
        payload: makePayload(),
        confirmNonce: 'nonce-123',
      }),
    );

    // Active task run exists (e.g. waiting on ask_followup_question)
    vi.mocked(findActiveLinearTaskRun).mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    } as Awaited<ReturnType<typeof findActiveLinearTaskRun>>);

    const payload = makePayload();
    const { rawBody, headers } = createSignedRequest(payload);

    const req = new Request('http://localhost/linear', {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const response = await app.request(req);
    expect(response.status).toBe(200);

    // The message MUST be queued to the active task run
    expect(queueLinearMessage).toHaveBeenCalledWith(
      42,
      'session-1',
      expect.objectContaining({ type: 'AgentSessionEvent' }),
      'user-1',
    );

    expect(routeTask).not.toHaveBeenCalled();
  });

  it('queues request_user_input answers for active task runs instead of plain follow-up prompts', async () => {
    setupDbMocks();

    vi.mocked(findActiveLinearTaskRun).mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    } as Awaited<ReturnType<typeof findActiveLinearTaskRun>>);
    vi.mocked(getPendingLinearRequestUserInput).mockResolvedValue({
      requestId: 'rui:session:turn:call',
      runId: 42,
      taskId: 'task-1',
      sessionId: 'session-1',
      status: 'pending',
      createdAt: Date.now(),
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
    });

    const payload = makePayload({
      agentActivity: {
        content: { body: '2' },
      },
    });
    const { rawBody, headers } = createSignedRequest(payload);

    const req = new Request('http://localhost/linear', {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const response = await app.request(req);
    expect(response.status).toBe(200);

    expect(queueLinearRequestUserInputAnswer).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        requestId: 'rui:session:turn:call',
        userId: 'user-1',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
      }),
    );
    expect(setTrustedRunActingUserOnSuccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 42,
        userId: 'user-1',
        operation: expect.any(Function),
      }),
    );
    expect(
      setTrustedRunActingUserOnSuccessMock.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      vi.mocked(queueLinearRequestUserInputAnswer).mock.invocationCallOrder[0]!,
    );
    expect(markPendingLinearRequestUserInputSubmitted).toHaveBeenCalledWith(
      'session-1',
      'rui:session:turn:call',
    );
    expect(queueLinearMessage).not.toHaveBeenCalled();
  });

  it('forwards conversational replies to the agent instead of consuming the pending question', async () => {
    setupDbMocks();

    vi.mocked(findActiveLinearTaskRun).mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    } as Awaited<ReturnType<typeof findActiveLinearTaskRun>>);
    vi.mocked(getPendingLinearRequestUserInput).mockResolvedValue({
      requestId: 'rui:session:turn:call',
      runId: 42,
      taskId: 'task-1',
      sessionId: 'session-1',
      status: 'pending',
      createdAt: Date.now(),
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
    });

    // A side question only "matches" via the isOther free-text fallback and
    // must reach the agent as a normal message, keeping the question pending.
    const payload = makePayload({
      agentActivity: {
        content: { body: 'whats the difference in practice?' },
      },
    });
    const { rawBody, headers } = createSignedRequest(payload);

    const req = new Request('http://localhost/linear', {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const response = await app.request(req);
    expect(response.status).toBe(200);

    expect(queueLinearRequestUserInputAnswer).not.toHaveBeenCalled();
    expect(markPendingLinearRequestUserInputSubmitted).not.toHaveBeenCalled();
    expect(queueLinearMessage).toHaveBeenCalledWith(
      42,
      'session-1',
      expect.objectContaining({ type: 'AgentSessionEvent' }),
      'user-1',
    );
  });

  it('delivers free-text reply to active task run even when a pending elicitation selection exists', async () => {
    setupDbMocks();

    // Simulate a pending elicitation selection
    vi.mocked(findPendingSelection).mockResolvedValue({
      step: 'awaiting_workspace',
      payload: makePayload(),
    } as Awaited<ReturnType<typeof findPendingSelection>>);

    // Active task run exists
    vi.mocked(findActiveLinearTaskRun).mockResolvedValue({
      id: 55,
      machineId: 'machine-2',
      taskId: 'task-2',
    } as Awaited<ReturnType<typeof findActiveLinearTaskRun>>);

    const payload = makePayload();
    const { rawBody, headers } = createSignedRequest(payload);

    const req = new Request('http://localhost/linear', {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const response = await app.request(req);
    expect(response.status).toBe(200);

    // The message MUST be queued to the active task run
    expect(queueLinearMessage).toHaveBeenCalledWith(
      55,
      'session-1',
      expect.objectContaining({ type: 'AgentSessionEvent' }),
      'user-1',
    );

    // The pending elicitation should have been cleaned up
    expect(deletePendingSelection).toHaveBeenCalledWith('session-1');

    // findPendingSelection should NOT have been checked (active task run short-circuits)
    expect(findPendingSelection).not.toHaveBeenCalled();
  });

  it('starts a routed task when no active task run exists', async () => {
    setupDbMocks();

    vi.mocked(findActiveLinearTaskRun).mockResolvedValue(null);
    vi.mocked(findPendingSelection).mockResolvedValue(null);
    vi.mocked(routeTask).mockResolvedValue({
      status: 'routed',
      result: {
        workspace: { type: 'all_repositories' },
        reasoning: 'Best fit for new task',
      },
    });

    const payload = makePayload();
    const { rawBody, headers } = createSignedRequest(payload);

    const req = new Request('http://localhost/linear', {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const response = await app.request(req);
    expect(response.status).toBe(200);

    expect(routeTask).toHaveBeenCalled();
    expect(createLinearAgentRun).toHaveBeenCalled();
    expect(queueLinearMessage).not.toHaveBeenCalled();
  });
});
