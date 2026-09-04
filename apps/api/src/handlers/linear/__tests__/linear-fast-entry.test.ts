import { Hono } from 'hono';
import { createHmac } from 'node:crypto';

const envState = vi.hoisted(() => ({
  R_LINEAR_WEBHOOK_SECRET: 'test-linear-secret',
  R_APP_URL: 'https://app.roomote.example',
  PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example',
  R_CURATED_INTEGRATIONS_DISABLED: false,
}));

const mocks = vi.hoisted(() => ({
  findLinearDeploymentMcpConnectionByIdentity: vi.fn(),
  findLinearUserMcpConnectionByIdentity: vi.fn(),
  getValidAccessToken: vi.fn(),
  createMcpOauthReplay: vi.fn(),
  resolveLinearAutomationLaunchUserId: vi.fn(),
  startLinearFastSessionTurn: vi.fn(),
  setTrustedRunActingUserOnSuccess: vi.fn(
    async ({ operation }: { operation: () => Promise<boolean> }) =>
      await operation(),
  ),
  emitThought: vi.fn().mockResolvedValue({ success: true }),
  emitError: vi.fn().mockResolvedValue({ success: true }),
  emitResponse: vi.fn().mockResolvedValue({ success: true }),
  emitElicitation: vi.fn().mockResolvedValue({ success: true }),
  findActiveLinearTaskRun: vi.fn(),
  getPendingLinearRequestUserInput: vi.fn(),
  clearPendingLinearRequestUserInput: vi.fn(),
  markPendingLinearRequestUserInputSubmitted: vi.fn(),
  queueLinearRequestUserInputAnswer: vi.fn(),
  cancelLinearTaskRun: vi.fn(),
  enrichSessionComments: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();
  return { ...actual, Env: envState };
});

vi.mock('@roomote/sdk/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/sdk/server')>();
  return {
    ...actual,
    findLinearDeploymentMcpConnectionByIdentity:
      mocks.findLinearDeploymentMcpConnectionByIdentity,
    findLinearUserMcpConnectionByIdentity:
      mocks.findLinearUserMcpConnectionByIdentity,
    getValidAccessToken: mocks.getValidAccessToken,
    createMcpOauthReplay: mocks.createMcpOauthReplay,
    resolveLinearAutomationLaunchUserId:
      mocks.resolveLinearAutomationLaunchUserId,
    startLinearFastSessionTurn: mocks.startLinearFastSessionTurn,
  };
});

vi.mock('@roomote/linear', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/linear')>();
  return {
    ...actual,
    verifyLinearWebhookSignature: vi.fn().mockReturnValue(true),
    isWebhookTimestampValid: vi.fn().mockReturnValue(true),
    parseAgentSessionEventPayload: vi
      .fn()
      .mockImplementation((data: unknown) => ({ success: true, data })),
    createLinearClient: vi.fn().mockReturnValue({
      emitThought: mocks.emitThought,
      emitError: mocks.emitError,
      emitResponse: mocks.emitResponse,
      emitElicitation: mocks.emitElicitation,
    }),
    findActiveLinearTaskRun: mocks.findActiveLinearTaskRun,
    getPendingLinearRequestUserInput: mocks.getPendingLinearRequestUserInput,
    clearPendingLinearRequestUserInput:
      mocks.clearPendingLinearRequestUserInput,
    markPendingLinearRequestUserInputSubmitted:
      mocks.markPendingLinearRequestUserInputSubmitted,
    queueLinearRequestUserInputAnswer: mocks.queueLinearRequestUserInputAnswer,
    cancelLinearTaskRun: mocks.cancelLinearTaskRun,
    enrichSessionComments: mocks.enrichSessionComments,
  };
});

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...actual,
    db: { select: vi.fn(), insert: vi.fn(), query: {} },
    resolveDeploymentEnvVar: vi.fn().mockResolvedValue('test-linear-secret'),
    setTrustedRunActingUserOnSuccess: mocks.setTrustedRunActingUserOnSuccess,
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

import { linear } from '../index';

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: 1_700_000_000_000,
    organizationId: 'linear-org-1',
    agentSession: {
      id: 'session-1',
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix the bug',
        description: 'Something is broken',
        url: 'https://linear.app/acme/issue/ENG-123',
      },
      creator: { id: 'linear-user-1', name: 'Dana' },
      comment: { id: 'comment-1', body: '@roomote please fix this' },
    },
    agentActivity: {
      id: 'activity-1',
      content: { body: '@roomote please fix this' },
    },
    ...overrides,
  };
}

async function post(payload: unknown) {
  const app = new Hono();
  app.route('/linear', linear);
  const rawBody = JSON.stringify(payload);
  return app.request(
    new Request('http://localhost/linear', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-delivery': `delivery-${Math.random()}`,
        'linear-signature': createHmac('sha256', 'test-linear-secret')
          .update(rawBody)
          .digest('hex'),
      },
      body: rawBody,
    }),
  );
}

describe('Linear agent session Fast entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.R_CURATED_INTEGRATIONS_DISABLED = false;
    mocks.findLinearDeploymentMcpConnectionByIdentity.mockResolvedValue({
      id: 'conn-org-1',
      authConfig: {
        linearOrganizationId: 'linear-org-1',
        linearOrganizationName: 'Linear Org',
        linearOrganizationUrlKey: 'linear-org',
        appUserId: 'linear-app-user',
      },
    });
    mocks.findLinearUserMcpConnectionByIdentity.mockResolvedValue({
      id: 'conn-user-1',
      userId: 'user-1',
      authConfig: {
        linearOrganizationId: 'linear-org-1',
        linearUserId: 'linear-user-1',
      },
    });
    mocks.getValidAccessToken.mockResolvedValue('valid-token');
    mocks.resolveLinearAutomationLaunchUserId.mockResolvedValue('admin-1');
    mocks.startLinearFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    mocks.findActiveLinearTaskRun.mockResolvedValue(null);
    mocks.getPendingLinearRequestUserInput.mockResolvedValue(null);
    mocks.enrichSessionComments.mockImplementation(
      async (_client: unknown, session: Record<string, unknown>) => ({
        ...session,
        previousComments: [{ id: 'c1', body: 'earlier note' }],
      }),
    );
  });

  it('acknowledges without processing when curated integrations are disabled', async () => {
    envState.R_CURATED_INTEGRATIONS_DISABLED = true;

    const response = await post(makePayload());

    expect(response.status).toBe(204);
    expect(mocks.startLinearFastSessionTurn).not.toHaveBeenCalled();
  });

  it('enters a new session into Fast with the enriched issue discussion', async () => {
    const payload = makePayload();

    const response = await post(payload);

    expect(response.status).toBe(200);
    expect(mocks.emitThought).toHaveBeenCalledWith(
      'session-1',
      'Getting started...',
      true,
    );
    expect(mocks.enrichSessionComments).toHaveBeenCalledTimes(1);
    expect(mocks.startLinearFastSessionTurn).toHaveBeenCalledWith({
      payload,
      agentSession: expect.objectContaining({
        id: 'session-1',
        previousComments: [{ id: 'c1', body: 'earlier note' }],
      }),
      userId: 'user-1',
      linearClient: expect.any(Object),
    });
    expect(mocks.emitError).not.toHaveBeenCalled();
  });

  it('enters a prompted follow-up into Fast without refetching comments', async () => {
    const payload = makePayload({
      action: 'prompted',
      agentActivity: { id: 'activity-2', content: { body: 'Any update?' } },
    });

    await post(payload);

    expect(mocks.emitThought).toHaveBeenCalledWith(
      'session-1',
      'Thinking...',
      true,
    );
    expect(mocks.enrichSessionComments).not.toHaveBeenCalled();
    expect(mocks.startLinearFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ payload, userId: 'user-1' }),
    );
  });

  it('runs a human-less delegation in the first administrator’s Session', async () => {
    const payload = makePayload({
      agentSession: {
        id: 'session-2',
        issue: {
          id: 'issue-2',
          identifier: 'ENG-124',
          title: 'Delegated issue',
          url: 'https://linear.app/acme/issue/ENG-124',
        },
      },
      agentActivity: undefined,
    });

    await post(payload);

    expect(mocks.findLinearUserMcpConnectionByIdentity).not.toHaveBeenCalled();
    expect(mocks.startLinearFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
    );
  });

  it('refuses a human-less delegation when no administrator exists', async () => {
    mocks.resolveLinearAutomationLaunchUserId.mockResolvedValue(null);

    await post(
      makePayload({
        agentSession: {
          id: 'session-2',
          issue: {
            id: 'issue-2',
            identifier: 'ENG-124',
            title: 'Delegated issue',
            url: 'https://linear.app/acme/issue/ENG-124',
          },
        },
        agentActivity: undefined,
      }),
    );

    expect(mocks.emitError).toHaveBeenCalledWith(
      'session-2',
      expect.stringContaining('administrator'),
    );
    expect(mocks.startLinearFastSessionTurn).not.toHaveBeenCalled();
  });

  it('asks an unlinked user to link their account instead of entering Fast', async () => {
    mocks.findLinearUserMcpConnectionByIdentity.mockResolvedValue(null);

    await post(makePayload());

    expect(mocks.createMcpOauthReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpId: 'linear',
        sessionId: 'session-1',
        metadata: {
          linearUserId: 'linear-user-1',
          linearOrganizationId: 'linear-org-1',
        },
      }),
    );
    expect(mocks.emitElicitation).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      expect.objectContaining({ signal: 'auth' }),
    );
    expect(mocks.startLinearFastSessionTurn).not.toHaveBeenCalled();
  });

  it('delivers an answer to a running task’s question instead of a Fast turn', async () => {
    mocks.findActiveLinearTaskRun.mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    });
    mocks.getPendingLinearRequestUserInput.mockResolvedValue({
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
          options: [{ label: 'TypeScript', description: 'Use the app stack.' }],
        },
      ],
    });

    await post(
      makePayload({
        action: 'prompted',
        agentActivity: {
          id: 'activity-3',
          content: { body: 'Could you use Go instead?' },
        },
      }),
    );

    expect(mocks.setTrustedRunActingUserOnSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 42, userId: 'user-1' }),
    );
    expect(mocks.queueLinearRequestUserInputAnswer).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        requestId: 'rui:session:turn:call',
        userId: 'user-1',
        answers: { language: { answers: ['Could you use Go instead?'] } },
      }),
    );
    expect(
      mocks.markPendingLinearRequestUserInputSubmitted,
    ).toHaveBeenCalledWith('session-1', 'rui:session:turn:call');
    expect(mocks.startLinearFastSessionTurn).not.toHaveBeenCalled();
  });

  it('hands a follow-up to Fast while a task runs without a pending question', async () => {
    mocks.findActiveLinearTaskRun.mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    });

    await post(
      makePayload({
        action: 'prompted',
        agentActivity: {
          id: 'activity-4',
          content: { body: 'Also update the docs.' },
        },
      }),
    );

    expect(mocks.queueLinearRequestUserInputAnswer).not.toHaveBeenCalled();
    expect(mocks.startLinearFastSessionTurn).toHaveBeenCalledTimes(1);
  });

  it('reports a Fast outage to the session as an error activity', async () => {
    mocks.startLinearFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
      reason: 'token expired',
    });

    await post(makePayload());

    expect(mocks.emitError).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining("couldn't start a conversation"),
    );
  });

  it('cancels the active task on a stop signal without entering Fast', async () => {
    mocks.findActiveLinearTaskRun.mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    });
    mocks.cancelLinearTaskRun.mockResolvedValue({ success: true });

    await post(
      makePayload({
        action: 'prompted',
        agentActivity: { id: 'activity-5', signal: 'stop', content: {} },
      }),
    );

    expect(mocks.cancelLinearTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      'session-1',
    );
    expect(mocks.emitResponse).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('stopped'),
    );
    expect(mocks.startLinearFastSessionTurn).not.toHaveBeenCalled();
  });
});
