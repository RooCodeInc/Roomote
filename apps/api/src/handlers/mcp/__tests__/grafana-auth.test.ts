import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

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
import { grafanaMcp } from '../grafana';

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

  app.route('/mcp', grafanaMcp);
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
    mcpId: 'grafana',
    enabled: true,
    authStatus: 'authenticated',
    authConfig: {
      type: 'grafana',
      baseUrl: 'https://acme.grafana.net',
      encryptedServiceAccountToken: 'enc:grafana-secret-token',
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

describe('grafana MCP auth and tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-1',
    });
    mockFindConnection.mockResolvedValue(mockConnectionRow());
  });

  it('initializes successfully for task run tokens', async () => {
    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'roomote-grafana-mcp', version: '1.0.0' },
      },
    });
  });

  it('lists the Grafana tools', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'list_dashboards' }),
          expect.objectContaining({ name: 'search_dashboards' }),
          expect.objectContaining({ name: 'get_dashboard' }),
          expect.objectContaining({ name: 'list_alert_rules' }),
          expect.objectContaining({ name: 'get_alert_rule' }),
          expect.objectContaining({ name: 'list_alert_instances' }),
          expect.objectContaining({ name: 'list_data_sources' }),
          expect.objectContaining({ name: 'list_annotations' }),
        ]),
      },
    });
  });

  it('lists Grafana dashboards through the stored token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 1,
            uid: 'abcd1234',
            title: 'Service overview',
            type: 'dash-db',
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'list_dashboards',
        arguments: {},
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          dashboards: [
            {
              id: 1,
              uid: 'abcd1234',
              title: 'Service overview',
              type: 'dash-db',
            },
          ],
          count: 1,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://acme.grafana.net/api/search?type=dash-db',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer grafana-secret-token',
        }),
      }),
    );
  });
});
