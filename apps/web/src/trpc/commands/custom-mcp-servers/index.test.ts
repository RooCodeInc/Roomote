import {
  customMcpServers,
  db,
  eq,
  inArray,
  mcpConnections,
  personalMcpServers,
  userFactory,
  users,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { customMcpConnectionId } from '@roomote/types';

const { captureEventMock } = vi.hoisted(() => ({
  captureEventMock: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: captureEventMock,
}));

import {
  CUSTOM_MCP_DISABLED_MESSAGE,
  assertCustomMcpEnabled,
  createCustomMcpServerCommand,
  deleteCustomMcpServerCommand,
  disconnectCustomMcpServerCommand,
  listCustomMcpServersCommand,
  listCustomMcpServerToolsCommand,
  setCustomMcpServerDisabledToolsCommand,
  setCustomMcpServerEnabledCommand,
  setCustomMcpServerVisibilityCommand,
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

const otherMemberAuth = {
  success: true,
  userType: 'user',
  userId: 'custom-mcp-other-member',
  isAdmin: false,
} as UserAuthSuccess;

const testUserIds = [
  adminAuth.userId,
  memberAuth.userId,
  otherMemberAuth.userId,
];

const remoteInput = {
  transport: 'remote' as const,
  name: 'internal-tools',
  url: 'https://mcp.example.com/mcp',
  authType: 'static_headers' as const,
  headers: { 'x-api-key': 'secret-one' },
};

async function cleanup() {
  const shared = await db
    .select({ id: customMcpServers.id })
    .from(customMcpServers)
    .where(inArray(customMcpServers.createdByUserId, testUserIds));
  const personal = await db
    .select({ id: personalMcpServers.id })
    .from(personalMcpServers)
    .where(inArray(personalMcpServers.ownerUserId, testUserIds));
  const ids = [...shared, ...personal].map(({ id }) => id);

  if (ids.length > 0) {
    await db
      .delete(mcpConnections)
      .where(inArray(mcpConnections.mcpId, ids.map(customMcpConnectionId)));
  }

  await db
    .delete(customMcpServers)
    .where(inArray(customMcpServers.createdByUserId, testUserIds));
  await db
    .delete(personalMcpServers)
    .where(inArray(personalMcpServers.ownerUserId, testUserIds));
}

describe('custom-mcp-servers commands', () => {
  beforeAll(async () => {
    await db.delete(users).where(inArray(users.id, testUserIds));
    for (const id of testUserIds) {
      await userFactory.create({ id });
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
  });
  afterAll(cleanup);

  it('keeps local (stdio) servers with administrators', async () => {
    await expect(
      createCustomMcpServerCommand(memberAuth, {
        transport: 'stdio',
        name: 'local-tools',
        stdio: { command: 'node' },
      }),
    ).rejects.toThrow('Unauthorized');
    await expect(
      createCustomMcpServerCommand(adminAuth, {
        transport: 'stdio',
        name: 'local-tools',
        stdio: { command: 'node' },
        visibility: 'owner',
      }),
    ).rejects.toThrow('cannot be personal');
  });

  describe('mirroring integration keys', () => {
    it('lets a member add a shared server that they and admins manage', async () => {
      const { id } = await createCustomMcpServerCommand(
        memberAuth,
        remoteInput,
      );

      const forCreator = await listCustomMcpServersCommand(memberAuth);
      const forOther = await listCustomMcpServersCommand(otherMemberAuth);
      const forAdmin = await listCustomMcpServersCommand(adminAuth);
      expect(forCreator.find((s) => s.id === id)).toMatchObject({
        visibility: 'deployment',
        canManage: true,
      });
      expect(forOther.find((s) => s.id === id)).toMatchObject({
        canManage: false,
      });
      expect(forAdmin.find((s) => s.id === id)).toMatchObject({
        canManage: true,
      });

      await expect(
        setCustomMcpServerEnabledCommand(otherMemberAuth, {
          id,
          enabled: false,
        }),
      ).rejects.toThrow('not found');
      await expect(
        deleteCustomMcpServerCommand(otherMemberAuth, { id }),
      ).rejects.toThrow('not found');
      await expect(
        setCustomMcpServerEnabledCommand(adminAuth, { id, enabled: false }),
      ).resolves.toEqual({ enabled: false });
      await expect(
        deleteCustomMcpServerCommand(memberAuth, { id }),
      ).resolves.toEqual({ deleted: true });
    });

    it('keeps a personal server invisible and unmanageable to everyone else, admins included', async () => {
      const { id } = await createCustomMcpServerCommand(memberAuth, {
        ...remoteInput,
        visibility: 'owner',
      });

      expect(
        await listCustomMcpServersCommand(memberAuth, { scope: 'owner' }),
      ).toEqual([
        expect.objectContaining({
          id,
          visibility: 'owner',
          canManage: true,
          headerNames: ['x-api-key'],
        }),
      ]);
      for (const auth of [adminAuth, otherMemberAuth]) {
        expect(
          await listCustomMcpServersCommand(auth, { scope: 'owner' }),
        ).toEqual([]);
        expect(
          (await listCustomMcpServersCommand(auth)).some((s) => s.id === id),
        ).toBe(false);
        await expect(
          setCustomMcpServerDisabledToolsCommand(auth, {
            id,
            disabledTools: ['x'],
          }),
        ).rejects.toThrow('not found');
        await expect(
          deleteCustomMcpServerCommand(auth, { id }),
        ).rejects.toThrow('not found');
      }

      const stored = await db.query.personalMcpServers.findFirst({
        where: eq(personalMcpServers.id, id),
      });
      expect(stored?.ownerUserId).toBe(memberAuth.userId);
      expect(decrypt(stored!.headers!['x-api-key']!)).toBe('secret-one');
      expect(
        await db.query.customMcpServers.findFirst({
          where: eq(customMcpServers.id, id),
        }),
      ).toBeUndefined();
    });

    it('lets two members use the same personal name', async () => {
      await createCustomMcpServerCommand(memberAuth, {
        ...remoteInput,
        visibility: 'owner',
      });
      await expect(
        createCustomMcpServerCommand(otherMemberAuth, {
          ...remoteInput,
          visibility: 'owner',
        }),
      ).resolves.toEqual({ id: expect.any(String) });
      await expect(
        createCustomMcpServerCommand(memberAuth, {
          ...remoteInput,
          visibility: 'owner',
        }),
      ).rejects.toThrow('already have a personal MCP server');
    });

    it('moves a server between private and shared with its id and connection', async () => {
      const { id } = await createCustomMcpServerCommand(memberAuth, {
        ...remoteInput,
        authType: 'oauth',
        headers: undefined,
        visibility: 'owner',
      });
      await db.insert(mcpConnections).values({
        userId: memberAuth.userId,
        mcpId: customMcpConnectionId(id),
        connectionRole: 'default',
        authConfig: {},
        enabled: true,
        authStatus: 'authenticated',
      });

      await expect(
        setCustomMcpServerVisibilityCommand(otherMemberAuth, {
          id,
          visibility: 'deployment',
        }),
      ).rejects.toThrow('not found');

      await setCustomMcpServerVisibilityCommand(memberAuth, {
        id,
        visibility: 'deployment',
      });
      expect(
        await db.query.personalMcpServers.findFirst({
          where: eq(personalMcpServers.id, id),
        }),
      ).toBeUndefined();
      expect(
        await db.query.customMcpServers.findFirst({
          where: eq(customMcpServers.id, id),
        }),
      ).toMatchObject({
        createdByUserId: memberAuth.userId,
        authType: 'oauth',
      });
      expect(
        await db.query.mcpConnections.findFirst({
          where: eq(mcpConnections.mcpId, customMcpConnectionId(id)),
        }),
      ).toMatchObject({ userId: null, authStatus: 'authenticated' });

      // An administrator may take it private again, to the member who added it.
      await setCustomMcpServerVisibilityCommand(adminAuth, {
        id,
        visibility: 'owner',
      });
      expect(
        await db.query.personalMcpServers.findFirst({
          where: eq(personalMcpServers.id, id),
        }),
      ).toMatchObject({ ownerUserId: memberAuth.userId });
      expect(
        await db.query.mcpConnections.findFirst({
          where: eq(mcpConnections.mcpId, customMcpConnectionId(id)),
        }),
      ).toMatchObject({ userId: memberAuth.userId });
    });
  });

  it('creates a server with encrypted header values and lists names only', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

    expect(captureEventMock).toHaveBeenCalledWith('integration_enabled', {
      userId: adminAuth.userId,
      properties: { integration_id: customMcpConnectionId(id) },
    });
    expect(captureEventMock).toHaveBeenCalledWith('integration_connected', {
      userId: adminAuth.userId,
      properties: { integration_id: customMcpConnectionId(id) },
    });

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
    captureEventMock.mockClear();

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
    expect(captureEventMock).toHaveBeenCalledWith('integration_removed', {
      userId: adminAuth.userId,
      properties: { integration_id: customMcpConnectionId(id) },
    });
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
    captureEventMock.mockClear();

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
    expect(captureEventMock).toHaveBeenCalledWith('integration_removed', {
      userId: adminAuth.userId,
      properties: { integration_id: customMcpConnectionId(id) },
    });
  });

  it('only captures custom OAuth removal when a connection existed', async () => {
    const { id } = await createCustomMcpServerCommand(adminAuth, {
      ...remoteInput,
      authType: 'oauth',
      headers: undefined,
    });
    captureEventMock.mockClear();

    await disconnectCustomMcpServerCommand(adminAuth, { id });
    expect(captureEventMock).not.toHaveBeenCalled();

    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: customMcpConnectionId(id),
      connectionRole: 'default',
      authConfig: {},
      enabled: true,
    });
    await disconnectCustomMcpServerCommand(adminAuth, { id });

    expect(captureEventMock).toHaveBeenCalledWith('integration_removed', {
      userId: adminAuth.userId,
      properties: { integration_id: customMcpConnectionId(id) },
    });
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

    expect(captureEventMock).toHaveBeenLastCalledWith('integration_disabled', {
      userId: adminAuth.userId,
      properties: { integration_id: customMcpConnectionId(id) },
    });

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
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2024-11-05' },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'mcp-session-id': 'sess-1',
            },
          },
        ),
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
    expect(notificationInit?.headers?.['mcp-protocol-version']).toBe(
      '2024-11-05',
    );
    expect(notificationInit?.headers?.['x-api-key']).toBe('secret-one');

    const [, listInit] = safeFetchMock.mock.calls[3]!;
    expect(JSON.parse(String(listInit?.body)).method).toBe('tools/list');
    expect(listInit?.headers?.['mcp-session-id']).toBe('sess-1');
    expect(listInit?.headers?.['mcp-protocol-version']).toBe('2024-11-05');
  });

  it.each([
    {
      responseName: 'a JSON-RPC error',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32001, message: 'Session required' },
      },
    },
    {
      responseName: 'no tool-list result',
      payload: { jsonrpc: '2.0', id: 1, result: {} },
    },
  ])(
    'initializes when a session-less tools/list returns $responseName',
    async ({ payload }) => {
      const { id } = await createCustomMcpServerCommand(adminAuth, remoteInput);

      safeFetchMock.mockReset();
      safeFetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'mcp-session-id': 'sess-1',
            },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
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

      const { tools } = await listCustomMcpServerToolsCommand(adminAuth, {
        id,
      });

      expect(tools).toEqual([
        { name: 'query', description: null, enabled: true },
      ]);
      expect(safeFetchMock).toHaveBeenCalledTimes(4);
    },
  );

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
