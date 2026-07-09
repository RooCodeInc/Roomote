import { Hono } from 'hono';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindCloudJob,
  mockFindConnection,
  mockResolveUserIdForCloudJob,
  mockEq,
  mockAnd,
  mockIsNull,
} = vi.hoisted(() => ({
  mockFindCloudJob: vi.fn(),
  mockFindConnection: vi.fn(),
  mockResolveUserIdForCloudJob: vi.fn(),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockAnd: vi.fn((...clauses: unknown[]) => clauses),
  mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      cloudJobs: { findFirst: mockFindCloudJob },
      mcpConnections: { findFirst: mockFindConnection },
    },
  },
  cloudJobs: { id: 'id' },
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

vi.mock('@roomote/cloud-agents/server', () => ({
  resolveCredentialUserIdForCloudJob: mockResolveUserIdForCloudJob,
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

function createJobToken(overrides?: Partial<JobTokenContext>): JobTokenContext {
  return {
    cloudJobId: 42,
    userId: 'user-1',
    tokenType: 'cj',
    version: 1,
    ...(overrides ?? {}),
  };
}

describe('asana MCP auth and tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCloudJob.mockResolvedValue({
      id: 42,
      userId: 'user-1',
    });
    mockResolveUserIdForCloudJob.mockImplementation(async (cloudJob) => {
      if (!cloudJob || typeof cloudJob !== 'object') {
        return null;
      }

      return 'userId' in cloudJob &&
        typeof cloudJob.userId === 'string' &&
        cloudJob.userId.length > 0
        ? cloudJob.userId
        : null;
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

  it('rejects user auth tokens for Asana access', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    const response = await postMcp(
      createApp(authToken),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.message).toContain('requires a cloud job token');
  });

  it('initializes successfully for cloud job tokens', async () => {
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
      createApp(createJobToken()),
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

  it('lists the Asana tools', async () => {
    const response = await postMcp(createApp(createJobToken()), {
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

    const response = await postMcp(createApp(createJobToken()), {
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

    const response = await postMcp(createApp(createJobToken()), {
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

    const response = await postMcp(createApp(createJobToken()), {
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
      createApp(createJobToken()),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.message).toBe(
      'No active Asana connection found for this workspace',
    );
  });
});
