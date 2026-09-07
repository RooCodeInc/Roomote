import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';
import { getMcpIntegration } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockFindConnection,
  mockFindEnablement,
  mockGetValidAccessToken,
  mockDecrypt,
  mockGetTaskHumanOwnerUserIds,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
  mockDecrypt: vi.fn(),
  mockGetTaskHumanOwnerUserIds: vi.fn(),
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
  getTaskHumanOwnerUserIds: mockGetTaskHumanOwnerUserIds,
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

vi.mock('@roomote/db/encryption', () => ({
  decrypt: mockDecrypt,
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

function createToolsListRequest(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  };
}

function createToolCallRequest(id: number, name: string) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  };
}

function createApp(
  integrationId: string,
  authContext: Variables['authContext'],
  options?: Parameters<typeof createIntegrationMcpProxy>[1],
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

  app.route('/mcp', createIntegrationMcpProxy(integration, options));
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
    mockFindEnablement.mockResolvedValue({
      disabledTools: null,
    });
    mockGetValidAccessToken.mockResolvedValue('valid-access-token');
    mockGetTaskHumanOwnerUserIds.mockResolvedValue([]);
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
      createApp('monday', createRunToken()),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.message).toContain('requires a human actor');
    expect(mockFindConnection).not.toHaveBeenCalled();
  });

  it('resolves a user-scoped monday.com connection for the live acting user', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: 'user-2' });
    mockFindConnection.mockResolvedValue({ id: 'conn-2', userId: 'user-2' });
    stubUpstreamFetch();

    const response = await postMcp(
      createApp(
        'monday',
        createRunToken({ userId: 'user-1', principal: 'user' }),
      ),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    expect(mockFindConnection).toHaveBeenCalledTimes(1);
  });

  it('resolves a user-scoped connection for a Fast user auth token', async () => {
    // Fast turns reach user-scoped proxies with the acting user's auth token;
    // credential resolution must stay pinned to the token holder.
    mockFindConnection.mockResolvedValue({ id: 'conn-3', userId: 'user-3' });
    stubUpstreamFetch();

    const response = await postMcp(
      createApp(
        'monday',
        { userId: 'user-3', tokenType: 'auth', version: 1 },
        { allowAuthTokens: true },
      ),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    expect(mockFindTaskRun).not.toHaveBeenCalled();
    expect(mockFindConnection).toHaveBeenCalledTimes(1);
  });

  it('still rejects a user auth token when auth tokens are not allowed', async () => {
    const response = await postMcp(
      createApp('monday', { userId: 'user-3', tokenType: 'auth', version: 1 }),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.message).toContain('only available for task run tokens');
    expect(mockFindConnection).not.toHaveBeenCalled();
  });

  it('forwards the decrypted admin-configured X bearer token upstream', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({
      id: 'conn-x',
      userId: null,
      authConfig: { type: 'x', encryptedBearerToken: 'encrypted-token' },
    });
    mockDecrypt.mockReturnValue('x-app-only-token');
    const fetchMock = stubUpstreamFetch();

    const response = await postMcp(
      createApp('x', createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    expect(mockDecrypt).toHaveBeenCalledWith('encrypted-token');
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();

    const upstreamHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(upstreamHeaders.get('authorization')).toBe(
      'Bearer x-app-only-token',
    );
  });

  it('rejects an X connection whose stored bearer token is empty', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({
      id: 'conn-x',
      userId: null,
      authConfig: { type: 'x', encryptedBearerToken: 'encrypted-token' },
    });
    mockDecrypt.mockReturnValue('   ');

    const response = await postMcp(
      createApp('x', createRunToken()),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.message).toContain('valid credentials');
  });

  it('normalizes an SSE-framed tool-call reply into a JSON response', async () => {
    // X's hosted MCP server answers tool calls with an SSE stream carrying the
    // single JSON-RPC response as one `data:` frame. The proxy must re-serialize
    // it to application/json so clients that do not consume SSE-framed POST
    // replies (e.g. OpenCode) receive the result instead of hanging.
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({
      id: 'conn-x',
      userId: null,
      authConfig: { type: 'x', encryptedBearerToken: 'encrypted-token' },
    });
    mockDecrypt.mockReturnValue('x-app-only-token');

    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"{\\"data\\":[]}"}]}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('x', createRunToken()),
      createToolCallRequest(7, 'get_users_posts'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: { content: Array<{ type: string }> };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(7);
    expect(body.result.content[0]?.type).toBe('text');
  });

  it('ignores SSE progress frames and returns the id-matched response', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({
      id: 'conn-x',
      userId: null,
      authConfig: { type: 'x', encryptedBearerToken: 'encrypted-token' },
    });
    mockDecrypt.mockReturnValue('x-app-only-token');

    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":9,"result":{"ok":true}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('x', createRunToken()),
      createToolCallRequest(9, 'search_posts_all'),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: number;
      result: { ok: boolean };
    };
    expect(body.id).toBe(9);
    expect(body.result.ok).toBe(true);
  });

  it('returns the SSE tool-call result without waiting for the stream to close', async () => {
    // A Streamable HTTP server may keep the SSE connection open after
    // delivering the matching response (to emit further notifications). The
    // proxy must return the moment the id-matched frame arrives rather than
    // block on stream closure, which would reintroduce the client-side hang.
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({
      id: 'conn-x',
      userId: null,
      authConfig: { type: 'x', encryptedBearerToken: 'encrypted-token' },
    });
    mockDecrypt.mockReturnValue('x-app-only-token');

    let cancelled = false;
    const neverClosingSseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: message\n' +
              'data: {"jsonrpc":"2.0","id":11,"result":{"ok":true}}\n\n',
          ),
        );
        // Deliberately never call controller.close(): simulate a server that
        // holds the SSE channel open after responding.
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(neverClosingSseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('x', createRunToken()),
      createToolCallRequest(11, 'get_users_posts'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      id: number;
      result: { ok: boolean };
    };
    expect(body.id).toBe(11);
    expect(body.result.ok).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('strips Resend tool schema patterns for Azure-compatible tool calls', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              {
                name: 'create-contact',
                inputSchema: {
                  type: 'object',
                  properties: {
                    email: {
                      type: 'string',
                      description: 'Contact email address',
                      pattern: '^(?!\\.)lookaround-pattern$',
                    },
                    nested: {
                      type: 'array',
                      items: { type: 'string', pattern: '^nested$' },
                    },
                  },
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('resend', createRunToken()),
      createToolsListRequest(1),
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: {
            properties: {
              email: Record<string, unknown>;
              nested: { items: Record<string, unknown> };
            };
          };
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools[0]?.inputSchema.properties.email).toEqual({
      type: 'string',
      description: 'Contact email address',
    });
    expect(body.result.tools[0]?.inputSchema.properties.nested.items).toEqual({
      type: 'string',
    });
  });

  it('normalizes simple nullable array tool input schemas', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              {
                name: 'search_issues',
                inputSchema: {
                  type: 'object',
                  properties: {
                    tags: {
                      type: ['null', 'array'],
                      items: { type: 'string' },
                      description: 'Tags to filter by',
                    },
                    constrained: {
                      type: ['array', 'null'],
                      items: { type: 'string' },
                      minItems: 1,
                    },
                  },
                },
                outputSchema: {
                  type: ['array', 'null'],
                  items: { type: 'string' },
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('pylon', createRunToken()),
      createToolsListRequest(1),
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: { properties: Record<string, unknown> };
          outputSchema: Record<string, unknown>;
        }>;
      };
    };

    const tool = body.result.tools[0];
    expect(response.status).toBe(200);
    expect(tool?.inputSchema.properties.tags).toEqual({
      description: 'Tags to filter by',
      anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
    });
    expect(tool?.inputSchema.properties.constrained).toEqual({
      type: ['array', 'null'],
      items: { type: 'string' },
      minItems: 1,
    });
    expect(tool?.outputSchema).toEqual({
      type: ['array', 'null'],
      items: { type: 'string' },
    });
  });
});
