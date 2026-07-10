import { Hono } from 'hono';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const { mockFindCloudJob, mockFindConnection, mockEq, mockAnd, mockIsNull } =
  vi.hoisted(() => ({
    mockFindCloudJob: vi.fn(),
    mockFindConnection: vi.fn(),
    mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
    mockAnd: vi.fn((...clauses: unknown[]) => clauses),
    mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
  }));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindCloudJob },
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
import { vercelMcp } from '../vercel';

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

  app.route('/mcp', vercelMcp);
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
    mcpId: 'vercel',
    enabled: true,
    authStatus: 'authenticated',
    authConfig: {
      type: 'vercel',
      encryptedAccessToken: 'enc:vercel-secret-token',
      defaultTeamIdOrSlug: 'team_123',
      ...(overrides ?? {}),
    },
  } as Awaited<ReturnType<typeof db.query.mcpConnections.findFirst>>;
}

function createJobToken(overrides?: Partial<JobTokenContext>): JobTokenContext {
  return {
    cloudJobId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'cj',
    version: 1,
    ...(overrides ?? {}),
  };
}

describe('vercel MCP auth and tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCloudJob.mockResolvedValue({
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

  it('rejects user auth tokens for Vercel access', async () => {
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
    const response = await postMcp(
      createApp(createJobToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'roomote-vercel-mcp', version: '1.0.0' },
      },
    });
  });

  it('accepts a token minted for user A after the acting user switched to user B', async () => {
    // Web steer / follow-up delivery mutate task_runs.actingUserId mid-run;
    // the run-scoped token stays authorized (the token's userId is mint-time
    // attribution and is never compared against the mutable acting user).
    mockFindCloudJob.mockResolvedValue({
      id: 42,
      actingUserId: 'user-2',
    });

    const response = await postMcp(
      createApp(createJobToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
  });

  it('accepts a deployment-principal token after a human became the acting user', async () => {
    // A human replying in the thread of an automation run switches the acting
    // user from null to that human; the run-scoped null-principal token must
    // keep working (default mock: actingUserId 'user-1').
    const response = await postMcp(
      createApp(createJobToken({ userId: null, principal: 'deployment' })),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
  });

  it('allows deployment-principal tokens for deployment-principal cloud jobs', async () => {
    mockFindCloudJob.mockResolvedValue({
      id: 42,
      actingUserId: null,
    });

    const response = await postMcp(
      createApp(createJobToken({ userId: null, principal: 'deployment' })),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        serverInfo: { name: 'roomote-vercel-mcp', version: '1.0.0' },
      },
    });
  });

  it('lists the Vercel tools', async () => {
    const response = await postMcp(createApp(createJobToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'list_teams' }),
          expect.objectContaining({ name: 'list_projects' }),
          expect.objectContaining({ name: 'get_project' }),
          expect.objectContaining({ name: 'list_deployments' }),
          expect.objectContaining({ name: 'get_deployment' }),
          expect.objectContaining({ name: 'get_deployment_build_logs' }),
          expect.objectContaining({ name: 'get_runtime_logs' }),
          expect.objectContaining({
            name: 'check_domain_availability_and_price',
          }),
        ]),
      },
    });
  });

  it('lists Vercel teams through the stored token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          teams: [{ id: 'team_123', slug: 'acme', name: 'Acme' }],
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
        name: 'list_teams',
        arguments: {
          limit: 25,
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          teams: [{ id: 'team_123', slug: 'acme', name: 'Acme' }],
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://api.vercel.com/v2/teams?limit=25',
      }),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('fetches runtime logs for a deployment and annotates the deployment context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          JSON.stringify({
            level: 'info',
            message: 'GET /api/health',
            rowId: 'req_123',
            source: 'request',
            timestampInMs: 1_700_000_000_000,
            domain: 'roomote-preview.vercel.app',
            messageTruncated: false,
            requestMethod: 'GET',
            requestPath: '/api/health',
            responseStatusCode: 200,
          }),
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'application/stream+json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createJobToken()), {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'get_runtime_logs',
        arguments: {
          projectId: 'prj_123',
          deploymentId: 'dpl_123',
          limit: 10,
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          logs: [
            expect.objectContaining({
              deploymentId: 'dpl_123',
              projectId: 'prj_123',
              rowId: 'req_123',
            }),
          ],
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://api.vercel.com/v1/projects/prj_123/deployments/dpl_123/runtime-logs?teamId=team_123',
      }),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('uses only the latest matching deployment when project runtime logs omit deploymentId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deployments: [
              { uid: 'dpl_latest', projectId: 'prj_123' },
              { uid: 'dpl_older', projectId: 'prj_123' },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            JSON.stringify({
              level: 'info',
              message: 'GET /latest',
              rowId: 'req_latest',
              source: 'request',
              timestampInMs: 1_700_000_000_000,
              domain: 'roomote-preview.vercel.app',
              messageTruncated: false,
              requestMethod: 'GET',
              requestPath: '/latest',
              responseStatusCode: 200,
            }),
          ].join('\n'),
          {
            status: 200,
            headers: { 'content-type': 'application/stream+json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createJobToken()), {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'get_runtime_logs',
        arguments: {
          projectId: 'prj_123',
          limit: 10,
          target: 'preview',
          since: 1_700_000_000_000,
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          logs: [
            expect.objectContaining({
              deploymentId: 'dpl_latest',
              projectId: 'prj_123',
              rowId: 'req_latest',
            }),
          ],
        },
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        href: 'https://api.vercel.com/v6/deployments?teamId=team_123&projectId=prj_123&since=1700000000000&target=preview&limit=1',
      }),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        href: 'https://api.vercel.com/v1/projects/prj_123/deployments/dpl_latest/runtime-logs?teamId=team_123',
      }),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches deployment details without requesting git repo info', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          uid: 'dpl_123',
          projectId: 'prj_123',
          name: 'roomote',
          url: 'roomote-preview.vercel.app',
          readyState: 'READY',
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
      id: 11,
      method: 'tools/call',
      params: {
        name: 'get_deployment',
        arguments: {
          idOrUrl: 'dpl_123',
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          deployment: expect.objectContaining({
            id: 'dpl_123',
            projectId: 'prj_123',
          }),
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://api.vercel.com/v13/deployments/dpl_123?teamId=team_123',
      }),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });
});
