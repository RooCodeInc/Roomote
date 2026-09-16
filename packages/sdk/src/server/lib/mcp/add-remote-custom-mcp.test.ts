import {
  customMcpServers,
  db,
  eq,
  inArray,
  mcpConnections,
  mcpOauthReplays,
  userFactory,
  users,
} from '@roomote/db/server';
import { customMcpConnectionId } from '@roomote/types';

const { guardedFetchMock } = vi.hoisted(() => ({
  guardedFetchMock: vi.fn(),
}));

vi.mock('../safe-fetch', () => ({
  createGuardedFetch: () => guardedFetchMock,
}));

import { addRemoteCustomMcpForFast } from './add-remote-custom-mcp';

const adminId = 'add-remote-mcp-admin';
const memberId = 'add-remote-mcp-member';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function initializedResponse() {
  return jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18' },
  });
}

function toolsResponse(name = 'search') {
  return jsonResponse({
    jsonrpc: '2.0',
    id: 2,
    result: { tools: [{ name, description: 'Search records' }] },
  });
}

function successfulMcpFetch() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { method?: string };
    if (body.method === 'initialize') return initializedResponse();
    if (body.method === 'tools/list') return toolsResponse();
    return new Response(null, { status: 202 });
  });
}

function noOAuthFetch(status: 401 | 403) {
  return vi.fn(async (url: string) =>
    url === 'https://mcp.example.com/mcp'
      ? new Response(null, { status })
      : new Response(null, { status: 404 }),
  );
}

async function cleanup() {
  const userIds = [adminId, memberId];
  const servers = await db.query.customMcpServers.findMany({
    where: inArray(customMcpServers.createdByUserId, userIds),
    columns: { id: true },
  });
  const serverIds = servers.map((server) => server.id);
  const mcpIds = serverIds.map(customMcpConnectionId);
  await db
    .delete(mcpOauthReplays)
    .where(inArray(mcpOauthReplays.userId, userIds));
  if (mcpIds.length > 0) {
    await db
      .delete(mcpOauthReplays)
      .where(inArray(mcpOauthReplays.mcpId, mcpIds));
    await db
      .delete(mcpConnections)
      .where(inArray(mcpConnections.mcpId, mcpIds));
    await db
      .delete(customMcpServers)
      .where(inArray(customMcpServers.id, serverIds));
  }
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(users).where(eq(users.id, memberId));
}

describe('addRemoteCustomMcpForFast', () => {
  beforeAll(async () => {
    await cleanup();
    await userFactory.create({ id: adminId, role: 'admin' });
    await userFactory.create({ id: memberId, role: 'member' });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    guardedFetchMock.mockReset();
    await cleanup();
    await userFactory.create({ id: adminId, role: 'admin' });
    await userFactory.create({ id: memberId, role: 'member' });
  });

  afterAll(cleanup);

  it('rejects members before probing or writing', async () => {
    await expect(
      addRemoteCustomMcpForFast({
        userId: memberId,
        sessionId: crypto.randomUUID(),
        name: 'records',
        url: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('Only deployment administrators');

    expect(guardedFetchMock).not.toHaveBeenCalled();
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('rejects HTTP before probing or persistence', async () => {
    await expect(
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'records',
        url: 'http://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('must use HTTPS');

    expect(guardedFetchMock).not.toHaveBeenCalled();
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('ignores unrelated legacy HTTP servers while adding an HTTPS server', async () => {
    await db.insert(customMcpServers).values({
      name: 'legacy-http',
      url: 'http://legacy.example.com/mcp',
      authType: 'none',
      createdByUserId: adminId,
    });
    guardedFetchMock.mockImplementation(successfulMcpFetch());

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'records',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({ status: 'connected', name: 'records' });
    expect(await db.query.customMcpServers.findMany()).toHaveLength(2);
  });

  it('normalizes a display name and returns the stored slug', async () => {
    guardedFetchMock.mockImplementation(successfulMcpFetch());

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: '  Acme & Billing MCP!  ',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'connected',
      name: 'acme-billing-mcp',
    });
    expect(await db.query.customMcpServers.findFirst()).toMatchObject({
      name: 'acme-billing-mcp',
    });
  });

  it('preserves underscores and reuses an existing name with a different URL', async () => {
    await db.insert(customMcpServers).values({
      name: 'acme_mcp',
      url: 'https://existing.example.com/mcp',
      authType: 'none',
      createdByUserId: adminId,
    });
    guardedFetchMock.mockResolvedValueOnce(toolsResponse());

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'Acme_MCP',
      url: 'https://different.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'connected',
      name: 'acme_mcp',
      reused: true,
    });
    expect(await db.query.customMcpServers.findMany()).toHaveLength(1);
  });

  it('deduplicates after normalizing the supplied name', async () => {
    await db.insert(customMcpServers).values({
      name: 'acme-mcp',
      url: 'https://mcp.example.com/mcp',
      authType: 'none',
      createdByUserId: adminId,
    });
    guardedFetchMock.mockResolvedValueOnce(toolsResponse());

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'Acme MCP',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'connected',
      name: 'acme-mcp',
      reused: true,
    });
    expect(await db.query.customMcpServers.findMany()).toHaveLength(1);
  });

  it('atomically reuses one URL across concurrent Fast Sessions', async () => {
    guardedFetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      return body.method === 'initialize'
        ? initializedResponse()
        : toolsResponse();
    });

    const [first, second] = await Promise.all([
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'First Name',
        url: 'https://mcp.example.com/mcp',
      }),
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'Second Name',
        url: 'https://MCP.EXAMPLE.com:443/mcp',
      }),
    ]);

    expect(new Set([first.id, second.id]).size).toBe(1);
    expect(new Set([first.name, second.name]).size).toBe(1);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(await db.query.customMcpServers.findMany()).toHaveLength(1);
  });

  it('rejects a name that normalizes to empty before probing or writing', async () => {
    await expect(
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: ' !!! ',
        url: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('Server name must be a lowercase slug');

    expect(guardedFetchMock).not.toHaveBeenCalled();
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('rejects 10,000 dashes without probing or writing', async () => {
    await expect(
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: '-'.repeat(10_000),
        url: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('Server name must be a lowercase slug');

    expect(guardedFetchMock).not.toHaveBeenCalled();
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('truncates normalized names to a valid 64-character boundary', async () => {
    guardedFetchMock.mockImplementation(successfulMcpFetch());
    const expectedName = 'a'.repeat(63);

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: `${expectedName} & trailing`,
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({ status: 'connected', name: expectedName });
    expect(await db.query.customMcpServers.findFirst()).toMatchObject({
      name: expectedName,
    });
  });

  it('verifies an unauthenticated server before creating it', async () => {
    guardedFetchMock.mockImplementation(successfulMcpFetch());

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'records',
      url: 'https://MCP.EXAMPLE.com:443/mcp',
    });

    expect(result).toMatchObject({
      status: 'connected',
      name: 'records',
      reused: false,
      tools: [{ name: 'search', description: 'Search records' }],
    });
    expect(await db.query.customMcpServers.findFirst()).toMatchObject({
      name: 'records',
      url: 'https://mcp.example.com/mcp',
      authType: 'none',
    });
  });

  it('reuses the probe initialization session for tool listing', async () => {
    const methods: string[] = [];
    guardedFetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      methods.push(body.method ?? '');
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          },
          200,
          { 'mcp-session-id': 'probe-session' },
        );
      }
      return body.method === 'tools/list'
        ? toolsResponse()
        : new Response(null, { status: 202 });
    });

    await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'records',
      url: 'https://mcp.example.com/mcp',
    });

    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(guardedFetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      'mcp-session-id': 'probe-session',
      'mcp-protocol-version': '2025-06-18',
    });
  });

  it('reuses a canonical URL match without creating a duplicate', async () => {
    await db.insert(customMcpServers).values({
      name: 'records',
      url: 'https://mcp.example.com/mcp',
      authType: 'none',
      createdByUserId: adminId,
    });
    guardedFetchMock.mockResolvedValueOnce(toolsResponse('lookup'));

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'different-name',
      url: 'https://MCP.EXAMPLE.com:443/mcp',
    });

    expect(result).toMatchObject({
      status: 'connected',
      name: 'records',
      reused: true,
    });
    expect(await db.query.customMcpServers.findMany()).toHaveLength(1);
  });

  it('refuses when the requested name and URL identify different servers', async () => {
    await db.insert(customMcpServers).values([
      {
        name: 'records',
        url: 'https://one.example.com/mcp',
        authType: 'none',
        createdByUserId: adminId,
      },
      {
        name: 'accounting',
        url: 'https://two.example.com/mcp',
        authType: 'none',
        createdByUserId: adminId,
      },
    ]);

    await expect(
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'records',
        url: 'https://two.example.com/mcp',
      }),
    ).rejects.toThrow('match different custom MCP servers');

    expect(guardedFetchMock).not.toHaveBeenCalled();
    expect(await db.query.customMcpServers.findMany()).toHaveLength(2);
  });

  it('returns Settings instead of connected tools for a reused disabled server', async () => {
    await db.insert(customMcpServers).values({
      name: 'records',
      url: 'https://mcp.example.com/mcp',
      authType: 'none',
      enabled: false,
      createdByUserId: adminId,
    });

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'records',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'disabled',
      name: 'records',
      reused: true,
    });
    expect((result as { settingsUrl: string }).settingsUrl).toContain(
      '/settings/integrations',
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it('returns a replay authorization link for discoverable OAuth', async () => {
    const metadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
    };
    guardedFetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(jsonResponse(metadata));

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'authorization_required',
      name: 'accounting',
      reused: false,
    });
    expect((result as { authorizeUrl: string }).authorizeUrl).toContain(
      '/api/mcp-oauth/replay/',
    );
    expect(await db.query.customMcpServers.findFirst()).toMatchObject({
      authType: 'oauth',
    });
    expect(await db.query.mcpConnections.findFirst()).toMatchObject({
      userId: null,
      authStatus: 'pending',
    });
    expect(await db.query.mcpOauthReplays.findFirst()).toMatchObject({
      userId: adminId,
    });
  });

  it('reuses a pending OAuth link for the same Session', async () => {
    const metadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
    };
    const sessionId = crypto.randomUUID();
    guardedFetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(metadata));
    const first = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId,
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
    });

    const second = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId,
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
    });

    expect(first).toMatchObject({ status: 'authorization_required' });
    expect(second).toMatchObject({
      status: 'authorization_required',
      reused: true,
      authorizeUrl: (first as { authorizeUrl: string }).authorizeUrl,
    });
    expect(await db.query.mcpOauthReplays.findMany()).toHaveLength(1);
  });

  it('uses Settings for a 401 response without OAuth metadata', async () => {
    guardedFetchMock.mockImplementation(noOAuthFetch(401));

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'private-records',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'needs_static_headers',
      name: 'private-records',
      reused: false,
    });
    expect((result as { settingsUrl: string }).settingsUrl).toContain(
      '/settings/integrations',
    );
    expect(result).not.toHaveProperty('id');
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('uses Settings without persistence for a 403 response without OAuth metadata', async () => {
    guardedFetchMock.mockImplementation(noOAuthFetch(403));

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'gateway-records',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'needs_static_headers',
      name: 'gateway-records',
      reused: false,
    });
    expect(result).not.toHaveProperty('id');
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('network unavailable'))],
    [
      'guard refusal',
      () => Promise.reject(new Error('Private address denied')),
    ],
    [
      'metadata 5xx',
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
  ])(
    'surfaces %s during OAuth discovery without persistence',
    async (_label, failure) => {
      guardedFetchMock
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockImplementation(failure);

      await expect(
        addRemoteCustomMcpForFast({
          userId: adminId,
          sessionId: crypto.randomUUID(),
          name: 'records',
          url: 'https://mcp.example.com/mcp',
        }),
      ).rejects.toThrow();

      expect(await db.query.customMcpServers.findMany()).toEqual([]);
    },
  );

  it('aborts an unresponsive probe after ten seconds', async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    try {
      guardedFetchMock.mockImplementation(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      const request = addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'records',
        url: 'https://mcp.example.com/mcp',
      });
      await vi.waitFor(() => expect(guardedFetchMock).toHaveBeenCalledOnce());
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      await expect(request).rejects.toThrow();
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('rejects a declared response larger than one MiB', async () => {
    guardedFetchMock.mockResolvedValueOnce(
      new Response('oversized', {
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
    );

    await expect(
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'records',
        url: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('exceeds 1048576 bytes');
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('rejects a streamed response larger than one MiB without content-length', async () => {
    const chunk = new Uint8Array(600 * 1024);
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.enqueue(chunk);
            controller.close();
          },
        }),
      ),
    );

    await expect(
      addRemoteCustomMcpForFast({
        userId: adminId,
        sessionId: crypto.randomUUID(),
        name: 'records',
        url: 'https://mcp.example.com/mcp',
      }),
    ).rejects.toThrow('exceeds 1048576 bytes');
    expect(await db.query.customMcpServers.findMany()).toEqual([]);
  });

  it('returns Settings without an authorization link after DCR failure', async () => {
    const [server] = await db
      .insert(customMcpServers)
      .values({
        name: 'accounting',
        url: 'https://mcp.example.com/mcp',
        authType: 'oauth',
        oauthServerMetadata: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          response_types_supported: ['code'],
        },
        createdByUserId: adminId,
      })
      .returning({ id: customMcpServers.id });
    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: customMcpConnectionId(server!.id),
      connectionRole: 'default',
      authStatus: 'error',
      enabled: false,
    });

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'client_registration_required',
      settingsUrl: expect.stringContaining('/settings/integrations'),
    });
    expect(result).not.toHaveProperty('authorizeUrl');
  });

  it('returns the reusable replay and Settings links for manual client registration', async () => {
    const metadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    };
    guardedFetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(jsonResponse(metadata));

    const result = await addRemoteCustomMcpForFast({
      userId: adminId,
      sessionId: crypto.randomUUID(),
      name: 'manual-client',
      url: 'https://mcp.example.com/mcp',
    });

    expect(result).toMatchObject({
      status: 'client_registration_required',
      name: 'manual-client',
      reused: false,
    });
    expect((result as { authorizeUrl: string }).authorizeUrl).toContain(
      '/api/mcp-oauth/replay/',
    );
    expect((result as { settingsUrl: string }).settingsUrl).toContain(
      '/settings/integrations',
    );
  });
});
