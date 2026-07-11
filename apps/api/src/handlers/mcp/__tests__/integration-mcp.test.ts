import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';
import { getMcpIntegration } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockFindConnection,
  mockFindEnablement,
  mockGetValidAccessToken,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      mcpConnections: { findFirst: mockFindConnection },
      deploymentMcpEnablements: { findFirst: mockFindEnablement },
    },
  },
  taskRuns: { id: 'id' },
  mcpConnections: {
    mcpId: 'mcpId',
    enabled: 'enabled',
    userId: 'userId',
  },
  deploymentMcpEnablements: {
    mcpId: 'mcpId',
    enabled: 'enabled',
  },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  and: vi.fn((...clauses: unknown[]) => clauses),
  isNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
}));

vi.mock('@roomote/sdk/server', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

import { createIntegrationMcpProxy } from '../integration-mcp';

type JsonRpcErrorBody = {
  error: { message: string };
};

function createInitializeRequest(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'roomote-api-test',
        version: '1.0.0',
      },
    },
  };
}

function createApp(
  integrationId: string,
  authContext: Variables['authContext'],
) {
  const integration = getMcpIntegration(integrationId);

  if (!integration) {
    throw new Error(`Unknown MCP integration in test setup: ${integrationId}`);
  }

  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });

  app.route('/mcp', createIntegrationMcpProxy(integration));
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

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
    ...(overrides ?? {}),
  };
}

function stubUpstreamFetch() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('createIntegrationMcpProxy acting-user scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockFindEnablement.mockResolvedValue({ disabledTools: null });
    mockGetValidAccessToken.mockResolvedValue('valid-access-token');
  });

  it('serves a deployment-scoped integration on a run with no human actor', async () => {
    // Slack automation launches (channel auto-start) run as the deployment
    // service principal; org-wide connections must still work for them.
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });
    stubUpstreamFetch();

    const response = await postMcp(
      createApp('supermemory', createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
  });

  it('serves a deployment-scoped integration on a run with a human actor', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: 'user-1' });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });
    stubUpstreamFetch();

    const response = await postMcp(
      createApp(
        'supermemory',
        createRunToken({ userId: 'user-1', principal: 'user' }),
      ),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
  });

  it('rejects a user-scoped integration on a run with no human actor', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });

    const response = await postMcp(
      createApp('notion', createRunToken()),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.message).toContain('requires a human actor');
    expect(mockFindConnection).not.toHaveBeenCalled();
  });

  it('resolves a user-scoped integration connection for the live acting user', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: 'user-2' });
    mockFindConnection.mockResolvedValue({ id: 'conn-2', userId: 'user-2' });
    stubUpstreamFetch();

    const response = await postMcp(
      createApp(
        'notion',
        createRunToken({ userId: 'user-1', principal: 'user' }),
      ),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    expect(mockFindConnection).toHaveBeenCalledTimes(1);
  });
});
