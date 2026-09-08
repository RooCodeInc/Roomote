import {
  customMcpServers,
  db,
  eq,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';
import { encrypt } from '@roomote/db/encryption';

const { fetchMock, tokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  tokenMock: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}));
vi.mock('./safe-fetch', async (original) => ({
  ...(await original<typeof import('./safe-fetch')>()),
  safeFetch: fetchMock,
}));
vi.mock('./mcp/data', () => ({ getValidAccessToken: tokenMock }));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

import { manageIntegrationConnection } from './manage-integration-connection';
import { createCustomMcpServerCommand } from './custom-mcp-servers';

const auth = { userId: 'integration-manager-test', isAdmin: true };
let sequence = 0;
const ids: string[] = [];

async function create(authType: 'none' | 'static_headers' | 'oauth' = 'none') {
  const name = `manager-${++sequence}`;
  const result = await manageIntegrationConnection(auth, {
    action: 'configure',
    name,
    url: 'https://mcp.example.com/mcp',
    authType,
  });
  expect(result.state).toBe('saved');
  const row = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.name, name),
  });
  if (!row) throw new Error('Missing saved server');
  expect(result).toMatchObject({
    setupUrl: `/settings/integrations?configure=custom%3A${row.id}`,
  });
  ids.push(row.id);
  return row;
}

function toolsResponse() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'read_items',
            description:
              'secret upstream description https://secret.example/token',
          },
          { name: 'delete_items' },
          { name: 'https://secret.example/token' },
        ],
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

beforeAll(async () => {
  await userFactory.create({ id: auth.userId });
});
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async () => toolsResponse());
  tokenMock.mockResolvedValue('oauth-secret');
});
afterEach(async () => {
  for (const id of ids.splice(0)) {
    await db
      .delete(mcpConnections)
      .where(eq(mcpConnections.mcpId, `custom:${id}`));
    await db.delete(customMcpServers).where(eq(customMcpServers.id, id));
  }
});

it('rejects non-admin callers', async () => {
  await expect(
    manageIntegrationConnection(
      { ...auth, isAdmin: false },
      { action: 'list' },
    ),
  ).rejects.toThrow('Unauthorized');
});

it('creates static-header configurations disabled and pending human credentials', async () => {
  const server = await create('static_headers');
  expect(server.enabled).toBe(false);
  expect(server.headers).toBeNull();
  const requested = await manageIntegrationConnection(auth, {
    action: 'request_auth',
    integrationId: `custom:${server.id}`,
  });
  expect(requested).toMatchObject({
    state: 'auth_pending',
    initiateUrl: `/settings/integrations?configure=custom%3A${server.id}`,
  });
  const tested = await manageIntegrationConnection(auth, {
    action: 'test',
    integrationId: `custom:${server.id}`,
  });
  expect(tested.state).toBe('failed');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  'http://127.0.0.1/mcp',
  'https://u:password@example.com/mcp',
  'https://example.com/mcp?token=secret',
  'https://example.com/mcp#secret',
])('rejects unsafe endpoint %s without echoing it', async (url) => {
  const result = await manageIntegrationConnection(auth, {
    action: 'configure',
    name: `manager-${++sequence}`,
    url,
  });
  expect(result.state).toBe('failed');
  expect(JSON.stringify(result)).not.toContain(url);
});

it('resolves native names before custom creation without claiming validation', async () => {
  const result = await manageIntegrationConnection(auth, {
    action: 'configure',
    name: 'Notion',
    url: 'https://mcp.example.com/mcp',
  });
  expect(result).toMatchObject({
    state: 'auth_pending',
    integrationId: 'notion',
  });
  expect(
    await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.name, 'Notion'),
    }),
  ).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('requires explicit permission review and authenticates before activation', async () => {
  const server = await create('static_headers');
  await db
    .update(customMcpServers)
    .set({ headers: { authorization: encrypt('Bearer static-secret') } })
    .where(eq(customMcpServers.id, server.id));
  expect(
    (
      await manageIntegrationConnection(auth, {
        action: 'permissions',
        integrationId: `custom:${server.id}`,
        enabled: true,
      })
    ).state,
  ).toBe('failed');
  const activated = await manageIntegrationConnection(auth, {
    action: 'permissions',
    integrationId: `custom:${server.id}`,
    disabledTools: ['delete_items'],
    enabled: true,
  });
  expect(activated).toMatchObject({ state: 'verified', enabled: true });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://mcp.example.com/mcp',
    expect.objectContaining({
      headers: expect.objectContaining({
        authorization: 'Bearer static-secret',
      }),
    }),
  );
  const result = await manageIntegrationConnection(auth, {
    action: 'test',
    integrationId: `custom:${server.id}`,
  });
  expect(result).toMatchObject({ state: 'verified', tools: ['read_items'] });
  expect(JSON.stringify(result)).not.toMatch(/secret|description|https:/);
});

it('does not activate a target changed during the authenticated probe', async () => {
  const server = await create();
  fetchMock.mockImplementationOnce(async () => {
    await db
      .update(customMcpServers)
      .set({
        url: 'https://changed.example.com/mcp',
        updatedAt: new Date(Date.now() + 1000),
      })
      .where(eq(customMcpServers.id, server.id));
    return toolsResponse();
  });
  const result = await manageIntegrationConnection(auth, {
    action: 'permissions',
    integrationId: `custom:${server.id}`,
    disabledTools: [],
    enabled: true,
  });
  expect(result.state).toBe('failed');
  expect(
    (
      await db.query.customMcpServers.findFirst({
        where: eq(customMcpServers.id, server.id),
      })
    )?.enabled,
  ).toBe(false);
});

it('keeps activation disabled on a failed probe and redacts upstream errors', async () => {
  const server = await create();
  fetchMock.mockRejectedValue(
    new Error('https://private.example?token=secret'),
  );
  const result = await manageIntegrationConnection(auth, {
    action: 'permissions',
    integrationId: `custom:${server.id}`,
    disabledTools: [],
    enabled: true,
  });
  expect(result.state).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(
    (
      await db.query.customMcpServers.findFirst({
        where: eq(customMcpServers.id, server.id),
      })
    )?.enabled,
  ).toBe(false);
});

it('clears credentials and disables a changed target', async () => {
  const server = await create('static_headers');
  await db
    .update(customMcpServers)
    .set({
      enabled: true,
      headers: { authorization: encrypt('secret') },
      manualClientId: 'old-client',
      manualClientSecret: 'old-secret',
    })
    .where(eq(customMcpServers.id, server.id));
  await db.insert(mcpConnections).values({
    mcpId: `custom:${server.id}`,
    userId: null,
    authConfig: {},
    enabled: true,
    authStatus: 'authenticated',
  });
  const result = await manageIntegrationConnection(auth, {
    action: 'configure',
    integrationId: `custom:${server.id}`,
    url: 'https://new.example.com/mcp',
  });
  expect(result.state).toBe('saved');
  expect(
    await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, server.id),
    }),
  ).toMatchObject({
    enabled: false,
    headers: null,
    manualClientId: null,
    manualClientSecret: null,
  });
  expect(
    await db.query.mcpConnections.findFirst({
      where: eq(mcpConnections.mcpId, `custom:${server.id}`),
    }),
  ).toBeUndefined();
});

it('starts OAuth with the existing shared connection and returns only a human initiation link', async () => {
  const server = await create('oauth');
  const requested = await manageIntegrationConnection(auth, {
    action: 'request_auth',
    integrationId: `custom:${server.id}`,
  });
  expect(requested).toMatchObject({
    state: 'auth_pending',
    enabled: false,
    initiateUrl: expect.stringMatching(/^\/api\/mcp-oauth\/initiate\//),
  });
  const connection = await db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.mcpId, `custom:${server.id}`),
  });
  expect(connection).toMatchObject({ enabled: false, authStatus: 'pending' });
  await manageIntegrationConnection(auth, {
    action: 'test',
    integrationId: `custom:${server.id}`,
  });
  expect(tokenMock).toHaveBeenCalledWith(connection!.id, server.url);
  expect(fetchMock).toHaveBeenCalledWith(
    server.url,
    expect.objectContaining({
      headers: expect.objectContaining({
        authorization: 'Bearer oauth-secret',
      }),
    }),
  );
});

it('preserves Settings default creation behavior in the extracted command', async () => {
  const result = await createCustomMcpServerCommand(auth, {
    transport: 'remote',
    name: `manager-${++sequence}`,
    url: 'https://example.com/mcp',
    authType: 'none',
  });
  ids.push(result.id);
  expect(
    (
      await db.query.customMcpServers.findFirst({
        where: eq(customMcpServers.id, result.id),
      })
    )?.enabled,
  ).toBe(true);
});
