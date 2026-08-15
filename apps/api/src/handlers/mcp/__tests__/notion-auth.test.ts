import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockFindConnection,
  mockFindEnablement,
  mockEq,
  mockAnd,
  mockIsNull,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockAnd: vi.fn((...clauses: unknown[]) => clauses),
  mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
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
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

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

function createToolCallRequest(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

describe('native Notion MCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockFindTaskRun.mockResolvedValue({ id: 42 });
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
    mockFindEnablement.mockResolvedValue({
      disabledTools: null,
      toolAccessMode: 'read_only',
    });
  });

  it('rejects user auth tokens', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };
    const response = await postMcp(createApp(authToken), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.status).toBe(403);
  });

  it('exposes only read tools by default', async () => {
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
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'notion-search',
        'notion-fetch',
        'notion-query-data-sources',
        'notion-get-comments',
      ]),
    );
    expect(toolNames).not.toContain('notion-update-page');
    expect(toolNames).not.toContain('notion-create-pages');
  });

  it('exposes writes only after read-write is enabled', async () => {
    mockFindEnablement.mockResolvedValue({
      disabledTools: null,
      toolAccessMode: 'read_write',
    });
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'notion-create-pages',
        'notion-update-page',
        'notion-append-blocks',
        'notion-create-comment',
      ]),
    );
  });

  it('keeps individually disabled write tools unavailable', async () => {
    mockFindEnablement.mockResolvedValue({
      disabledTools: ['notion-update-page'],
      toolAccessMode: 'read_write',
    });
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(body.result.tools.map((tool) => tool.name)).not.toContain(
      'notion-update-page',
    );
  });

  it('searches through the Notion API using only the stored integration secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-search', { query: 'roadmap' }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/search'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer notion-internal-secret',
          'Notion-Version': '2026-03-11',
        }),
      }),
    );
  });

  it('rejects legacy hosted-MCP OAuth credentials', async () => {
    mockFindConnection.mockResolvedValue({
      authConfig: {
        type: 'oauth_client',
        client_id: 'legacy',
        registered_redirect_uri: 'https://example.com/callback',
      },
    });

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(500);
    expect(body.error.message).toContain('internal integration configuration');
  });
});
