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
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
  mockDecrypt: vi.fn(),
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

  it('normalizes an SSE tools/list result without waiting for the stream to close', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });

    let cancelled = false;
    const neverClosingSseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: message\n' +
              'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search_issues","inputSchema":{"type":"object","properties":{"tags":{"type":["array","null"],"items":{"type":"string"}}}}}]}}\n\n',
          ),
        );
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
      createApp('pylon', createRunToken()),
      createToolsListRequest(1),
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: { properties: Record<string, unknown> };
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.result.tools[0]?.inputSchema.properties.tags).toEqual({
      anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
    });
    expect(cancelled).toBe(true);
  });

  it('preserves an uncorrelatable SSE tools/list stream without waiting for closure', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });

    let cancelled = false;
    const neverClosingSseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: message\n' +
              'data: {"jsonrpc":"2.0","id":null,"result":{"tools":[]}}\n\n',
          ),
        );
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

    const response = await postMcp(createApp('pylon', createRunToken()), {
      jsonrpc: '2.0',
      id: null,
      method: 'tools/list',
      params: {},
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
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

  it('normalizes tool input schemas that Gemini function declarations reject', async () => {
    // Pylon's search filters use `type: ["array", "null"]` unions and bare
    // array schemas; the AI SDK's Gemini conversion splits the union into
    // anyOf branches while leaving `items` outside them, and Google AI
    // Studio then rejects the whole request ("any_of[0].items: missing
    // field"), killing every Gemini task turn for the workspace.
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
                      type: ['array', 'null'],
                      items: { type: 'string' },
                      description: 'Tags to filter by',
                    },
                    custom_field_filters: {
                      type: ['array', 'null'],
                      items: {
                        type: 'object',
                        properties: { slug: { type: 'string' } },
                        required: ['slug'],
                      },
                    },
                    bare_list: {
                      type: 'array',
                      description: 'Array with no item shape',
                    },
                    status: { type: ['string', 'null'] },
                  },
                },
                outputSchema: {
                  type: 'object',
                  properties: {
                    matches: {
                      type: ['array', 'null'],
                      items: { type: 'string' },
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
      createApp('pylon', createRunToken()),
      createToolsListRequest(1),
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: { properties: Record<string, unknown> };
          outputSchema: { properties: Record<string, unknown> };
        }>;
      };
    };

    expect(response.status).toBe(200);
    const properties = body.result.tools[0]?.inputSchema.properties ?? {};
    expect(properties.tags).toEqual({
      description: 'Tags to filter by',
      anyOf: [
        // Branches keep only their own type's structural keywords;
        // annotations like `description` live at the top level only.
        { type: 'array', items: { type: 'string' } },
        { type: 'null' },
      ],
    });
    expect(properties.custom_field_filters).toEqual({
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            properties: { slug: { type: 'string' } },
            required: ['slug'],
          },
        },
        { type: 'null' },
      ],
    });
    expect(properties.bare_list).toEqual({
      type: 'array',
      description: 'Array with no item shape',
      items: { type: 'string' },
    });
    // Scalar unions convert cleanly downstream; leave them untouched.
    expect(properties.status).toEqual({ type: ['string', 'null'] });
    // Output schemas do not become Gemini function declarations and must
    // remain the upstream MCP server's unmodified contract.
    expect(body.result.tools[0]?.outputSchema.properties.matches).toEqual({
      type: ['array', 'null'],
      items: { type: 'string' },
    });
  });

  it('never destroys declared items, data values, or foreign-type keywords', async () => {
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
                    // Draft-04 tuple, boolean, and empty-object items are all
                    // declared contracts and must pass through untouched.
                    tuple_list: {
                      type: 'array',
                      items: [{ type: 'string' }, { type: 'number' }],
                    },
                    flexible_list: { type: 'array', items: true },
                    any_list: { type: 'array', items: {} },
                    // A default whose value merely looks like a schema is
                    // data and must not be rewritten.
                    raw_filter: {
                      type: 'object',
                      default: { type: 'array' },
                    },
                    // A union's shared keywords go only to the branches they
                    // are valid on; annotations stay at the top level.
                    id_or_ids: {
                      type: ['string', 'array'],
                      minLength: 1,
                      pattern: '^[a-z]+$',
                      items: { type: 'string' },
                      default: null,
                    },
                  },
                },
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('pylon', createRunToken()),
      createToolsListRequest(1),
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{ inputSchema: { properties: Record<string, unknown> } }>;
      };
    };

    expect(response.status).toBe(200);
    const properties = body.result.tools[0]?.inputSchema.properties ?? {};
    expect(properties.tuple_list).toEqual({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
    });
    expect(properties.flexible_list).toEqual({ type: 'array', items: true });
    expect(properties.any_list).toEqual({ type: 'array', items: {} });
    expect(properties.raw_filter).toEqual({
      type: 'object',
      default: { type: 'array' },
    });
    expect(properties.id_or_ids).toEqual({
      anyOf: [
        { type: 'string', minLength: 1, pattern: '^[a-z]+$' },
        { type: 'array', items: { type: 'string' } },
      ],
      default: null,
    });
  });

  it('filters an SSE tools/list whose id is echoed as a different type', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });
    mockFindEnablement.mockResolvedValue({ disabledTools: ['secret_tool'] });

    // The request sends a numeric id; a non-conformant upstream echoes it as
    // a string. The filtered rebuild must still apply instead of forwarding
    // the raw (unfiltered) stream.
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":"1","result":{"tools":[{"name":"search_issues","inputSchema":{"type":"object"}},{"name":"secret_tool","inputSchema":{"type":"object"}}]}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp('pylon', createRunToken()),
      createToolsListRequest(1),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'search_issues',
    ]);
  });

  it('filters an uncorrelatable SSE tools/list for a restricted connection', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });
    mockFindEnablement.mockResolvedValue({ disabledTools: ['secret_tool'] });

    // An id-less request cannot be correlated to an SSE frame, but a
    // restricted connection must still get the filtered rebuild (via the
    // bounded buffered read) rather than the raw upstream stream.
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":null,"result":{"tools":[{"name":"search_issues","inputSchema":{"type":"object"}},{"name":"secret_tool","inputSchema":{"type":"object"}}]}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp('pylon', createRunToken()), {
      jsonrpc: '2.0',
      id: null,
      method: 'tools/list',
      params: {},
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'search_issues',
    ]);
  });

  it('refuses to forward an unfilterable tools/list to a restricted connection', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: null });
    mockFindConnection.mockResolvedValue({ id: 'conn-1', userId: null });
    mockFindEnablement.mockResolvedValue({ disabledTools: ['secret_tool'] });

    // The stream closes without ever carrying a JSON-RPC response, so there
    // is nothing to filter; a restricted connection must get an error, never
    // the raw upstream bytes.
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp('pylon', createRunToken()), {
      jsonrpc: '2.0',
      id: null,
      method: 'tools/list',
      params: {},
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('could not be filtered');
  });
});
