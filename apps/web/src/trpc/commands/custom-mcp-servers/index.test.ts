import {
  customMcpServers,
  db,
  eq,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { customMcpConnectionId } from '@roomote/types';

import {
  CUSTOM_MCP_DISABLED_MESSAGE,
  assertCustomMcpEnabled,
  createCustomMcpServerCommand,
  deleteCustomMcpServerCommand,
  listCustomMcpServersCommand,
  listCustomMcpServerToolsCommand,
  setCustomMcpServerDisabledToolsCommand,
  setCustomMcpServerEnabledCommand,
  updateCustomMcpServerCommand,
} from './index';

vi.mock('@roomote/sdk/server/safe-fetch', () => ({
  safeFetch: vi.fn(),
}));

import { safeFetch } from '@roomote/sdk/server/safe-fetch';

const safeFetchMock = vi.mocked(safeFetch);

import type { UserAuthSuccess } from '@/types';

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'custom-mcp-admin',
  isAdmin: true,
} as UserAuthSuccess;

const memberAuth = {
  success: true,
  userType: 'user',
  userId: 'custom-mcp-member',
  isAdmin: false,
} as UserAuthSuccess;

const remoteInput = {
  transport: 'remote' as const,
  name: 'internal-tools',
  url: 'https://mcp.example.com/mcp',
  authType: 'static_headers' as const,
  headers: { 'x-api-key': 'secret-one' },
};

async function cleanup() {
  await db.delete(customMcpServers);
  await db.delete(mcpConnections);
}

describe('custom-mcp-servers commands', () => {
  beforeAll(async () => {
    await userFactory.create({ id: adminAuth.userId });
  });

  beforeEach(cleanup);
  afterAll(cleanup);

  it('rejects non-admin users on every command', async () => {
    await expect(listCustomMcpServersCommand(memberAuth)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      createCustomMcpServerCommand(memberAuth, remoteInput),
    ).rejects.toThrow('Unauthorized');
    await expect(
      deleteCustomMcpServerCommand(memberAuth, { id: crypto.randomUUID() }),
    ).rejects.toThrow('Unauthorized');
  });

  it('creates a server with encrypted header values and lists names only', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    const row = await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, id),
    });

    expect(row?.headers?.['x-api-key']).toBeDefined();
    expect(row?.headers?.['x-api-key']).not.toBe('secret-one');
    expect(decrypt(row!.headers!['x-api-key']!)).toBe('secret-one');

    const listed = await listCustomMcpServersCommand(adminAuth);

    expect(listed).toHaveLength(1);
    expect(listed[0]!.headerNames).toEqual(['x-api-key']);
    expect(JSON.stringify(listed[0])).not.toContain('secret-one');
  });

  it('rejects duplicate names', async () => {
    await createCustomMcpServerCommand(adminAuth, remoteInput);

    await expect(
      createCustomMcpServerCommand(adminAuth, remoteInput),
    ).rejects.toThrow(/already exists/);
  });

  it('keeps existing header values on blank edit and re-encrypts new ones', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    await updateCustomMcpServerCommand(adminAuth, {
      id,
      server: {
        ...remoteInput,
        headers: { 'x-api-key': '', 'x-second': 'second-value' },
      },
    });

    const row = await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, id),
    });

    expect(decrypt(row!.headers!['x-api-key']!)).toBe('secret-one');
    expect(decrypt(row!.headers!['x-second']!)).toBe('second-value');
  });

  it('rejects blank header values on create', async () => {
    await expect(
      createCustomMcpServerCommand(adminAuth, {
        ...remoteInput,
        headers: { 'x-api-key': '' },
      }),
    ).rejects.toThrow(/value is required/);
  });

  it('clears OAuth connections when the URL changes', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, {
      ...remoteInput,
      authType: 'oauth',
      headers: undefined,
    });

    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: customMcpConnectionId(id),
      connectionRole: 'default',
      authConfig: {},
      enabled: true,
      authStatus: 'authenticated',
      accessToken: 'stored-access-token',
    });

    const result = await updateCustomMcpServerCommand(adminAuth, {
      id,
      server: {
        ...remoteInput,
        authType: 'oauth',
        headers: undefined,
        url: 'https://other.example.com/mcp',
      },
    });

    expect(result.credentialsCleared).toBe(true);

    const connections = await db.query.mcpConnections.findMany({
      where: eq(mcpConnections.mcpId, customMcpConnectionId(id)),
    });

    expect(connections).toHaveLength(0);
  });

  it('keeps OAuth connections when only headers change', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: customMcpConnectionId(id),
      connectionRole: 'default',
      authConfig: {},
      enabled: true,
      authStatus: 'authenticated',
    });

    const result = await updateCustomMcpServerCommand(adminAuth, {
      id,
      server: {
        ...remoteInput,
        headers: { 'x-api-key': 'rotated' },
      },
    });

    expect(result.credentialsCleared).toBe(false);

    const connections = await db.query.mcpConnections.findMany({
      where: eq(mcpConnections.mcpId, customMcpConnectionId(id)),
    });

    expect(connections).toHaveLength(1);
  });

  it('creates stdio servers with encrypted env values', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, {
      transport: 'stdio',
      name: 'local-tools',
      stdio: {
        command: 'npx',
        args: ['-y', '@example/server'],
        env: { EXAMPLE_TOKEN: 'stdio-secret' },
      },
    });

    const row = await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, id),
    });

    expect(row?.url).toBeNull();
    expect(row?.stdio?.command).toBe('npx');
    expect(row?.stdio?.env?.EXAMPLE_TOKEN).not.toBe('stdio-secret');
    expect(decrypt(row!.stdio!.env!.EXAMPLE_TOKEN!)).toBe('stdio-secret');

    const listed = await listCustomMcpServersCommand(adminAuth);

    expect(listed[0]!.transport).toBe('stdio');
    expect(listed[0]!.stdioEnvNames).toEqual(['EXAMPLE_TOKEN']);
    expect(JSON.stringify(listed[0])).not.toContain('stdio-secret');
  });

  it('deletes servers together with their connections', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: customMcpConnectionId(id),
      connectionRole: 'default',
      authConfig: {},
      enabled: true,
    });

    const result = await deleteCustomMcpServerCommand(adminAuth, { id });

    expect(result.deleted).toBe(true);
    expect(
      await db.query.customMcpServers.findMany({
        where: eq(customMcpServers.id, id),
      }),
    ).toHaveLength(0);
    expect(
      await db.query.mcpConnections.findMany({
        where: eq(mcpConnections.mcpId, customMcpConnectionId(id)),
      }),
    ).toHaveLength(0);
  });

  it('toggles enabled and persists disabled tools', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    await setCustomMcpServerDisabledToolsCommand(adminAuth, {
      id,
      disabledTools: ['dangerous_tool'],
    });

    let listed = await listCustomMcpServersCommand(adminAuth);
    expect(listed[0]!.disabledTools).toEqual(['dangerous_tool']);

    await setCustomMcpServerEnabledCommand(adminAuth, { id, enabled: false });

    listed = await listCustomMcpServersCommand(adminAuth);
    expect(listed[0]!.enabled).toBe(false);
  });

  it('allows editing the tool deny list on a disabled server', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);
    await setCustomMcpServerEnabledCommand(adminAuth, { id, enabled: false });

    await setCustomMcpServerDisabledToolsCommand(adminAuth, {
      id,
      disabledTools: ['dangerous_tool'],
    });

    const listed = await listCustomMcpServersCommand(adminAuth);
    expect(listed[0]!.disabledTools).toEqual(['dangerous_tool']);
    expect(listed[0]!.enabled).toBe(false);
  });

  it('sends notifications/initialized before the session tools/list fallback', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    safeFetchMock.mockReset();
    safeFetchMock
      // Session-less tools/list refused by a strict server.
      .mockResolvedValueOnce(new Response('session required', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-1',
          },
        }),
      )
      // notifications/initialized is accepted without a body.
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'query', description: 'Run a query' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const { tools } = await listCustomMcpServerToolsCommand(adminAuth, { id });

    expect(tools).toEqual([
      { name: 'query', description: 'Run a query', enabled: true },
    ]);
    expect(safeFetchMock).toHaveBeenCalledTimes(4);

    const [, notificationInit] = safeFetchMock.mock.calls[2]!;
    expect(JSON.parse(String(notificationInit?.body))).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notificationInit?.headers?.['mcp-session-id']).toBe('sess-1');
    expect(notificationInit?.headers?.['x-api-key']).toBe('secret-one');

    const [, listInit] = safeFetchMock.mock.calls[3]!;
    expect(JSON.parse(String(listInit?.body)).method).toBe('tools/list');
    expect(listInit?.headers?.['mcp-session-id']).toBe('sess-1');
  });

  it('still lists tools when the initialized notification is refused', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    safeFetchMock.mockReset();
    safeFetchMock
      .mockResolvedValueOnce(new Response('session required', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-1',
          },
        }),
      )
      // A lenient server that rejects the notification outright.
      .mockRejectedValueOnce(new Error('unexpected notification'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'query' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const { tools } = await listCustomMcpServerToolsCommand(adminAuth, { id });

    expect(tools).toEqual([
      { name: 'query', description: null, enabled: true },
    ]);
  });

  it('kill switch blocks mutations with a clear message', () => {
    expect(() => assertCustomMcpEnabled('true')).toThrow(
      CUSTOM_MCP_DISABLED_MESSAGE,
    );
    expect(() => assertCustomMcpEnabled(undefined)).not.toThrow();
  });
});
