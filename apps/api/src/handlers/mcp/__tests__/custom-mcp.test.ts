import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockEnv,
  mockFindTaskRun,
  mockFindCustomServer,
  mockFindConnection,
  mockGetValidAccessToken,
} = vi.hoisted(() => ({
  mockEnv: {
    R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS: undefined as string | undefined,
    R_CUSTOM_MCP_DISABLED: false,
  },
  mockFindTaskRun: vi.fn(),
  mockFindCustomServer: vi.fn(),
  mockFindConnection: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
  isCustomMcpDisabled: (value: boolean | undefined) => value === true,
  areCuratedIntegrationsDisabled: (value: boolean | undefined) =>
    value === true,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      customMcpServers: { findFirst: mockFindCustomServer },
      mcpConnections: { findFirst: mockFindConnection },
    },
  },
  taskRuns: { id: 'id' },
  customMcpServers: { id: 'id', enabled: 'enabled' },
  mcpConnections: { mcpId: 'mcpId', enabled: 'enabled', userId: 'userId' },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  and: vi.fn((...clauses: unknown[]) => clauses),
  isNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc\(|\)$/g, '')),
}));

vi.mock('@roomote/sdk/server', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

import { createCustomMcpProxy } from '../custom-mcp';

const SERVER_ID = '4c72c9dd-3f5e-4d3e-9f7a-2c1b8a6e5d40';

function createRunToken(): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
  };
}

function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', createRunToken());
    await next();
  });

  app.route('/custom/:serverId', createCustomMcpProxy());
  return app;
}

function buildServerRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: SERVER_ID,
    name: 'internal-tools',
    url: 'http://127.0.0.1:0/mcp',
    authType: 'static_headers',
    headers: { 'x-api-key': 'enc(secret-one)' },
    stdio: null,
    disabledTools: null,
    enabled: true,
    ...overrides,
  };
}

async function postMcp(
  app: Hono<{ Variables: Variables }>,
  body: unknown,
  serverId: string = SERVER_ID,
) {
  return app.request(`/custom/${serverId}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'roomote-api-test', version: '1.0.0' },
  },
};

describe('createCustomMcpProxy', () => {
  let upstream: Server;
  let upstreamPort: number;
  let lastUpstreamHeaders: IncomingHttpHeaders | null = null;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      lastUpstreamHeaders = req.headers;

      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.1/internal');
        res.end();
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'safe_tool', description: 'ok' },
              { name: 'dangerous_tool', description: 'no' },
            ],
          },
        }),
      );
    });

    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });

    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lastUpstreamHeaders = null;
    mockEnv.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS = '127.0.0.0/8';
    mockFindTaskRun.mockResolvedValue({ id: 42 });
  });

  function upstreamUrl(path = '/mcp') {
    return `http://127.0.0.1:${upstreamPort}${path}`;
  }

  it('404s for malformed server ids without touching the database', async () => {
    const response = await postMcp(
      createApp(),
      initializeRequest,
      'not-a-uuid',
    );

    expect(response.status).toBe(404);
    expect(mockFindCustomServer).not.toHaveBeenCalled();
  });

  it('404s for unknown servers', async () => {
    mockFindCustomServer.mockResolvedValue(undefined);

    const response = await postMcp(createApp(), initializeRequest);

    expect(response.status).toBe(404);
  });

  it('proxies to the upstream with decrypted static headers and no Authorization', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({ url: upstreamUrl() }),
    );

    const response = await postMcp(createApp(), initializeRequest);

    expect(response.status).toBe(200);
    expect(lastUpstreamHeaders?.['x-api-key']).toBe('secret-one');
    expect(lastUpstreamHeaders?.authorization).toBeUndefined();
  });

  it('injects the OAuth access token for oauth servers', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({ url: upstreamUrl(), authType: 'oauth', headers: null }),
    );
    mockFindConnection.mockResolvedValue({ id: 'conn-1' });
    mockGetValidAccessToken.mockResolvedValue('custom-access-token');

    const response = await postMcp(createApp(), initializeRequest);

    expect(response.status).toBe(200);
    expect(lastUpstreamHeaders?.authorization).toBe(
      'Bearer custom-access-token',
    );
  });

  it('returns a reconnect error when oauth tokens are missing', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({ url: upstreamUrl(), authType: 'oauth', headers: null }),
    );
    mockFindConnection.mockResolvedValue(undefined);

    const response = await postMcp(createApp(), initializeRequest);

    expect(response.status).toBe(401);

    const body = (await response.json()) as { error: { message: string } };

    expect(body.error.message).toContain('reconnected');
  });

  it('403s deny-listed tool calls without contacting the upstream', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({
        url: upstreamUrl(),
        disabledTools: ['dangerous_tool'],
      }),
    );

    const response = await postMcp(createApp(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dangerous_tool', arguments: {} },
    });

    expect(response.status).toBe(403);
    expect(lastUpstreamHeaders).toBeNull();
  });

  it('filters deny-listed tools out of tools/list responses', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({
        url: upstreamUrl(),
        disabledTools: ['dangerous_tool'],
      }),
    );

    const response = await postMcp(createApp(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      result: { tools: { name: string }[] };
    };

    expect(body.result.tools.map((tool) => tool.name)).toEqual(['safe_tool']);
  });

  it('refuses upstream redirects instead of following them', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({ url: upstreamUrl('/redirect') }),
    );

    const response = await postMcp(createApp(), initializeRequest);

    expect(response.status).toBe(502);

    const body = (await response.json()) as { error: { message: string } };

    expect(body.error.message).toContain('redirect');
  });

  it('refuses private upstreams without a CIDR allowance', async () => {
    mockEnv.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS = undefined;
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({ url: upstreamUrl() }),
    );

    const response = await postMcp(createApp(), initializeRequest);

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(lastUpstreamHeaders).toBeNull();
  });

  it('rejects oversized request bodies', async () => {
    mockFindCustomServer.mockResolvedValue(
      buildServerRow({ url: upstreamUrl() }),
    );

    const response = await postMcp(createApp(), {
      ...initializeRequest,
      params: { blob: 'x'.repeat(1024 * 1024 + 1) },
    });

    expect(response.status).toBe(413);
    expect(lastUpstreamHeaders).toBeNull();
  });
});
