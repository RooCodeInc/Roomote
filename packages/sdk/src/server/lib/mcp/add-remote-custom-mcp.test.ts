import {
  customMcpServers,
  db,
  eq,
  mcpConnections,
  mcpOauthReplays,
  userFactory,
  users,
} from '@roomote/db/server';

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

async function cleanup() {
  await db.delete(mcpOauthReplays);
  await db.delete(mcpConnections);
  await db.delete(customMcpServers);
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
    await db.delete(mcpOauthReplays);
    await db.delete(mcpConnections);
    await db.delete(customMcpServers);
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

  it('verifies an unauthenticated server before creating it', async () => {
    guardedFetchMock
      .mockResolvedValueOnce(initializedResponse())
      .mockResolvedValueOnce(toolsResponse());

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
    guardedFetchMock.mockImplementation(
      async () => new Response(null, { status: 401 }),
    );

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
    expect(await db.query.customMcpServers.findFirst()).toMatchObject({
      authType: 'static_headers',
      headers: null,
    });
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
