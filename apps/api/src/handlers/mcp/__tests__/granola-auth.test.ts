import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const { mockFindTaskRun, mockFindConnection, mockEq, mockAnd, mockIsNull } =
  vi.hoisted(() => ({
    mockFindTaskRun: vi.fn(),
    mockFindConnection: vi.fn(),
    mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
    mockAnd: vi.fn((...clauses: unknown[]) => clauses),
    mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
  }));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      mcpConnections: { findFirst: mockFindConnection },
    },
  },
  taskRuns: { id: 'id' },
  mcpConnections: {
    mcpId: 'mcpId',
    enabled: 'enabled',
    authStatus: 'authStatus',
    userId: 'userId',
  },
  eq: mockEq,
  and: mockAnd,
  isNull: mockIsNull,
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) =>
    value.startsWith('enc:') ? value.slice(4) : value,
  ),
}));

import { db } from '@roomote/db/server';
import { granolaMcp } from '../granola';

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
      clientInfo: { name: 'roomote-api-test', version: '1.0.0' },
    },
  };
}

function createApp(authContext: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });

  app.route('/mcp', granolaMcp);
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

function mockConnectionRow(overrides?: Record<string, unknown>) {
  return {
    id: 'conn-1',
    userId: null,
    mcpId: 'granola',
    enabled: true,
    authStatus: 'authenticated',
    authConfig: {
      type: 'granola',
      encryptedApiKey: 'enc:granola-secret-key',
      ...(overrides ?? {}),
    },
  } as unknown as Awaited<ReturnType<typeof db.query.mcpConnections.findFirst>>;
}

function createRunToken(): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };
}

function createToolCall(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

describe('Granola MCP auth and tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTaskRun.mockResolvedValue({ id: 42 });
    mockFindConnection.mockResolvedValue(mockConnectionRow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects requests without authentication', async () => {
    const response = await postMcp(
      createApp(undefined),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.message).toContain('missing or invalid bearer token');
  });

  it('accepts user auth tokens for control-plane Granola access', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };
    const response = await postMcp(
      createApp(authToken),
      createInitializeRequest(1),
    );
    expect(response.status).toBe(200);
  });

  it('initializes for a valid run token and deployment connection', async () => {
    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        serverInfo: { name: 'roomote-granola-mcp', version: '1.0.0' },
      },
    });
    expect(mockIsNull).toHaveBeenCalledWith('userId');
  });

  it('exposes only the three read-only Granola tools', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          annotations: Record<string, boolean>;
        }>;
      };
    };

    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'list_notes',
      'get_note',
      'list_folders',
    ]);
    expect(body.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          annotations: {
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
            readOnlyHint: true,
          },
        }),
      ]),
    );
  });

  it('lists notes with official filters, pagination, and decrypted bearer auth', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ notes: [], hasMore: true, cursor: 'next-cursor' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCall('list_notes', {
        created_before: '2026-02-01',
        created_after: '2026-01-01T00:00:00Z',
        updated_after: '2026-01-15',
        folder_id: 'fol_4y6LduVdwSKC27',
        cursor: 'current-cursor',
        page_size: 30,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          notes: [],
          hasMore: true,
          cursor: 'next-cursor',
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://public-api.granola.ai/v1/notes?created_before=2026-02-01&created_after=2026-01-01T00%3A00%3A00Z&updated_after=2026-01-15&folder_id=fol_4y6LduVdwSKC27&cursor=current-cursor&page_size=30',
    );
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer granola-secret-key',
    );
  });

  it('gets a note with transcript inclusion exactly as documented', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ id: 'not_1d3tmYTlCICgjy' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCall('get_note', {
        note_id: 'not_1d3tmYTlCICgjy',
        include: 'transcript',
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: { note: { id: 'not_1d3tmYTlCICgjy' } },
      },
    });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe(
      'https://public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy?include=transcript',
    );
  });

  it('lists folders with official pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        folders: [{ id: 'fol_4y6LduVdwSKC27', name: 'Recipes' }],
        hasMore: false,
        cursor: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCall('list_folders', { cursor: 'folder-cursor', page_size: 5 }),
    );

    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          folders: [{ id: 'fol_4y6LduVdwSKC27', name: 'Recipes' }],
          hasMore: false,
          cursor: null,
        },
      },
    });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe(
      'https://public-api.granola.ai/v1/folders?cursor=folder-cursor&page_size=5',
    );
  });

  it('surfaces structured Granola API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { errors: [{ message: 'The supplied API key is invalid' }] },
            { status: 401 },
          ),
        ),
    );

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCall('list_notes', {}),
    );
    const body = (await response.json()) as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message?: string };
    };

    expect(response.status).toBe(200);
    expect(body.error?.message ?? body.result?.content?.[0]?.text).toContain(
      'The supplied API key is invalid',
    );
  });

  it('returns 404 when no active Granola deployment connection exists', async () => {
    mockFindConnection.mockResolvedValue(undefined);

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.message).toBe(
      'No active Granola connection found for this workspace',
    );
  });
});
