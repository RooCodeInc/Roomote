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
import { asanaMcp } from '../asana';

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

function createApp(authContext: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });

  app.route('/mcp', asanaMcp);
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
    mcpId: 'asana',
    enabled: true,
    authStatus: 'authenticated',
    authConfig: {
      type: 'asana',
      encryptedToken: 'enc:asana-secret-token',
      ...(overrides ?? {}),
    },
  } as Awaited<ReturnType<typeof db.query.mcpConnections.findFirst>>;
}

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
    ...(overrides ?? {}),
  };
}

describe('asana MCP auth and tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-1',
    });
    mockFindConnection.mockResolvedValue(mockConnectionRow());
  });

  it('rejects when auth context is missing', async () => {
    const response = await postMcp(
      createApp(undefined),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.message).toContain('Unauthorized');
  });

  it('accepts user auth tokens for control-plane Asana access', async () => {
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

  it('initializes successfully for task run tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'roomote-asana-mcp', version: '1.0.0' },
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      },
    });
  });

  it('accepts a token minted for user A after the acting user switched to user B', async () => {
    // Web steer / follow-up delivery mutate task_runs.actingUserId mid-run;
    // the run-scoped token stays authorized (the token's userId is mint-time
    // attribution and is never compared against the mutable acting user).
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-2',
    });

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
  });

  it('accepts a deployment-principal token after a human became the acting user', async () => {
    // A human replying in the thread of an automation run switches the acting
    // user from null to that human; the run-scoped null-principal token must
    // keep working.
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-2',
    });

    const response = await postMcp(
      createApp(createRunToken({ userId: null, principal: 'deployment' })),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
  });

  it('allows deployment-principal tokens for deployment-principal task runs', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: null,
    });

    const response = await postMcp(
      createApp(createRunToken({ userId: null, principal: 'deployment' })),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        serverInfo: { name: 'roomote-asana-mcp', version: '1.0.0' },
      },
    });
  });

  it('lists the Asana tools', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'list_workspaces' }),
          expect.objectContaining({ name: 'get_project' }),
          expect.objectContaining({ name: 'list_projects' }),
          expect.objectContaining({ name: 'get_task' }),
          expect.objectContaining({ name: 'list_tasks_for_project' }),
          expect.objectContaining({ name: 'search_tasks' }),
          expect.objectContaining({ name: 'get_task_comments' }),
          expect.objectContaining({ name: 'list_teams' }),
          expect.objectContaining({ name: 'get_user' }),
        ]),
      },
    });
  });

  it('lists workspaces through the Asana REST API with the stored token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ gid: '123', name: 'Engineering' }],
          next_page: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'list_workspaces',
        arguments: {},
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          workspaces: [{ gid: '123', name: 'Engineering' }],
          next_page: null,
        },
      },
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(requestUrl.toString()).toBe(
      'https://app.asana.com/api/1.0/workspaces',
    );
    expect(
      new Headers(requestInit.headers as HeadersInit).get('authorization'),
    ).toBe('Bearer asana-secret-token');
  });

  it('uses Asana search scope query keys when searching tasks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ gid: 'task-1', name: 'Scoped task' }],
          next_page: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'search_tasks',
        arguments: {
          workspace_gid: 'workspace-123',
          text: 'reporting',
          project: 'project-456',
          assignee: 'user-789',
        },
      },
    });

    expect(response.status).toBe(200);

    const [requestUrl] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.searchParams.get('projects.any')).toBe('project-456');
    expect(requestUrl.searchParams.get('assignee.any')).toBe('user-789');
    expect(requestUrl.searchParams.get('project')).toBeNull();
    expect(requestUrl.searchParams.get('assignee')).toBeNull();
  });

  it('filters task stories down to comments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                gid: 'story-comment',
                type: 'comment',
                text: 'Looks good',
              },
              {
                gid: 'story-system',
                resource_subtype: 'assigned',
                text: 'Task assigned',
              },
            ],
            next_page: null,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'get_task_comments',
        arguments: {
          task_gid: 'task-123',
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          comments: [
            { gid: 'story-comment', type: 'comment', text: 'Looks good' },
          ],
          next_page: null,
        },
      },
    });
  });

  it('returns 404 when no active Asana connection exists', async () => {
    mockFindConnection.mockResolvedValue(undefined);

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.message).toBe(
      'No active Asana connection found for this workspace',
    );
  });
});
