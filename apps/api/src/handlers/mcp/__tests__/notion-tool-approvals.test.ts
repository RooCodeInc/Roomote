import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockFindConnection,
  mockFindEnablement,
  mockEq,
  mockAnd,
  mockIsNull,
  mockGetValidAccessToken,
  mockExperiment,
  mockAutoState,
  mockShadowEvaluation,
  mockDeploymentPolicies,
  mockUserPolicies,
  mockSessionForTask,
  mockSessionOverrides,
  mockClaim,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockAnd: vi.fn((...clauses: unknown[]) => clauses),
  mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
  mockGetValidAccessToken: vi.fn(),
  mockExperiment: vi.fn(async () => true),
  mockAutoState: vi.fn(async () => ({ mode: 'off' as const })),
  mockShadowEvaluation: vi.fn(),
  mockDeploymentPolicies: vi.fn(async () => [] as unknown[]),
  mockUserPolicies: vi.fn(async () => [] as unknown[]),
  mockSessionForTask: vi.fn(async () => null as { id: string } | null),
  mockSessionOverrides: vi.fn(async () => [] as unknown[]),
  mockClaim: vi.fn(async () => false),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      mcpConnections: { findFirst: mockFindConnection },
      deploymentMcpEnablements: { findFirst: mockFindEnablement },
    },
  },
  taskRuns: { id: 'taskRun.id' },
  mcpConnections: {
    mcpId: 'connection.mcpId',
    enabled: 'connection.enabled',
    authStatus: 'connection.authStatus',
    userId: 'connection.userId',
  },
  deploymentMcpEnablements: {
    mcpId: 'enablement.mcpId',
    enabled: 'enablement.enabled',
  },
  eq: mockEq,
  and: mockAnd,
  isNull: mockIsNull,
  getTaskHumanOwnerUserIds: vi.fn(async () => [] as string[]),
  isDeploymentExperimentEnabled: mockExperiment,
  listIntegrationToolPolicies: mockDeploymentPolicies,
  listIntegrationToolUserPolicies: mockUserPolicies,
  getSessionForTask: mockSessionForTask,
  listIntegrationToolSessionOverrides: mockSessionOverrides,
  claimTaskIntegrationToolCall: mockClaim,
  fingerprintIntegrationToolCall: (input: unknown) => JSON.stringify(input),
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

vi.mock('@roomote/sdk/server/mcp-data', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

vi.mock(
  '@roomote/cloud-agents/server/integration-tool-auto-evaluation',
  () => ({
    resolveIntegrationToolAutoState: mockAutoState,
    recordIntegrationToolShadowEvaluationInBackground: mockShadowEvaluation,
  }),
);

import { notionMcp } from '../notion';

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
    ...overrides,
  };
}

function createApp(authContext: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.route('/mcp', notionMcp);
  return app;
}

async function postMcp(app: Hono<{ Variables: Variables }>, body: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'auto' | 'ask' | 'reject',
) => ({ integrationId, toolName, mode });

describe('native Notion MCP tool approval enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockExperiment.mockResolvedValue(true);
    mockAutoState.mockResolvedValue({ mode: 'off' });
    mockDeploymentPolicies.mockResolvedValue([]);
    mockUserPolicies.mockResolvedValue([]);
    mockSessionForTask.mockResolvedValue(null);
    mockSessionOverrides.mockResolvedValue([]);
    mockClaim.mockResolvedValue(false);
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-1',
      taskId: 'task-1',
    });
    mockFindConnection.mockResolvedValue({
      id: 'conn-notion',
      userId: null,
      mcpId: 'notion',
      enabled: true,
      authStatus: 'authenticated',
      authConfig: {
        type: 'notion',
        encryptedToken: 'enc:notion-internal-secret',
      },
    });
    mockFindEnablement.mockResolvedValue({ mcpId: 'notion' });
    mockGetValidAccessToken.mockResolvedValue('notion-oauth-token');
  });

  it('refuses a task run calling a rejected tool without contacting Notion', async () => {
    mockDeploymentPolicies.mockResolvedValue([
      policy('notion', 'notion-search', 'reject'),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'notion-search', arguments: { query: 'roadmap' } },
    });
    const body = (await response.json()) as {
      id: number;
      error: { message: string };
    };

    expect(response.status).toBe(403);
    expect(body.id).toBe(7);
    expect(body.error.message).toContain('notion-search');
    expect(body.error.message).toContain('disabled by a tool approval policy');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a task run calling an ask-first tool until the call is approved', async () => {
    mockDeploymentPolicies.mockResolvedValue([
      policy('notion', 'notion-search', 'ask'),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(createRunToken());
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'notion-search', arguments: { query: 'roadmap' } },
    };

    const held = await postMcp(app, call);
    expect(held.status).toBe(403);
    expect(
      ((await held.json()) as { error: { message: string } }).error.message,
    ).toContain('needs approval');
    expect(fetchMock).not.toHaveBeenCalled();

    mockClaim.mockResolvedValue(true);
    const approved = await postMcp(app, call);
    expect(approved.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledWith({
      taskId: 'task-1',
      argsFingerprint: JSON.stringify({
        integrationId: 'notion',
        toolName: 'notion-search',
        args: { query: 'roadmap' },
      }),
    });
  });

  it('fails closed when the approval claim cannot be read', async () => {
    mockDeploymentPolicies.mockResolvedValue([
      policy('notion', 'notion-search', 'ask'),
    ]);
    mockClaim.mockRejectedValue(new Error('database unavailable'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'notion-search', arguments: { query: 'roadmap' } },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides rejected tools from tools/list for a task run', async () => {
    mockDeploymentPolicies.mockResolvedValue([
      policy('notion', 'notion-search', 'reject'),
    ]);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const toolNames = body.result.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(toolNames).not.toContain('notion-search');
    expect(toolNames).toContain('notion-fetch');
  });

  it('rejects batch requests while a policy blocks any tool', async () => {
    mockDeploymentPolicies.mockResolvedValue([
      policy('notion', 'notion-search', 'reject'),
    ]);

    const response = await postMcp(createApp(createRunToken()), [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);

    expect(response.status).toBe(400);
  });

  it('blocks nothing and reads nothing while the experiment is off', async () => {
    mockExperiment.mockResolvedValue(false);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.status).toBe(200);
    expect(mockDeploymentPolicies).not.toHaveBeenCalled();
    expect(mockUserPolicies).not.toHaveBeenCalled();
  });
});
