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
  setCustomMcpServerDisabledToolsCommand,
  setCustomMcpServerEnabledCommand,
  updateCustomMcpServerCommand,
} from './index';

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

  it('kill switch blocks mutations with a clear message', () => {
    expect(() => assertCustomMcpEnabled('true')).toThrow(
      CUSTOM_MCP_DISABLED_MESSAGE,
    );
    expect(() => assertCustomMcpEnabled(undefined)).not.toThrow();
  });
});
