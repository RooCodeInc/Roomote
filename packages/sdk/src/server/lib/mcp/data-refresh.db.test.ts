import { createServer, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import {
  db,
  deploymentMcpEnablements,
  eq,
  mcpConnections,
  userFactory,
  users,
} from '@roomote/db/server';
import { decryptText } from '@roomote/db/encryption';
import { getValidAccessToken, storeTokens } from './data';
import { resolveUserMcpServerConfigs } from '../../routers/mcp-connections';

const nativeFetch = globalThis.fetch;
const mcpUrl = 'https://mcp.linear.app/mcp';
let providerUrl: string;
let userId: string;
let requests: Array<{ response: ServerResponse; refreshToken: string | null }>;
let respond: (response: ServerResponse) => void;
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  requests.push({
    response,
    refreshToken: new URLSearchParams(body).get('refresh_token'),
  });
  respond(response);
});

function reply(response: ServerResponse, body: object, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function reject(response: ServerResponse) {
  reply(response, { error: 'invalid_grant' }, 400);
}
async function createConnection(mcpId = 'linear') {
  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId,
      mcpId,
      authStatus: 'authenticated',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenExpiresAt: new Date(0),
      authConfig: {
        type: 'oauth_client',
        client_id: 'fixture-client',
        registered_redirect_uri:
          'http://localhost:13540/api/mcp-oauth/callback',
        token_endpoint_auth_method: 'none',
      },
    })
    .returning();
  return connection!;
}
async function readConnection(id: string) {
  return db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.id, id),
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) =>
    provider.listen(0, '127.0.0.1', resolve),
  );
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/token`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});
beforeEach(async () => {
  requests = [];
  respond = reject;
  userId = (await userFactory.create()).id;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.linear.app/oauth/token');
      return nativeFetch(providerUrl, init);
    },
  );
});
afterEach(async () => {
  for (const { response } of requests)
    if (!response.writableEnded) response.end();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.delete(users).where(eq(users.id, userId));
});

it('stops retrying a rejected grant and resumes after reconnect stores fresh tokens', async () => {
  const connection = await createConnection();
  expect(await getValidAccessToken(connection.id, mcpUrl)).toBeUndefined();
  expect((await readConnection(connection.id))?.authStatus).toBe('error');
  expect(await getValidAccessToken(connection.id, mcpUrl)).toBeUndefined();
  expect(requests).toHaveLength(1);
  await storeTokens(connection.id, {
    access_token: 'reconnected-access',
    refresh_token: 'reconnected-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
  });
  expect(await getValidAccessToken(connection.id, mcpUrl)).toBe(
    'reconnected-access',
  );
  expect(requests).toHaveLength(1);
  expect((await readConnection(connection.id))?.authStatus).toBe(
    'authenticated',
  );
});

it('does not let a late rejected refresh overwrite a successful token rotation', async () => {
  const connection = await createConnection();
  respond = () => {};
  const first = getValidAccessToken(connection.id, mcpUrl);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const second = getValidAccessToken(connection.id, mcpUrl);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map((request) => request.refreshToken)).toEqual([
    'old-refresh',
    'old-refresh',
  ]);
  reply(requests[0]!.response, {
    access_token: 'rotated-access',
    refresh_token: 'rotated-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
  });
  expect(await first).toBe('rotated-access');
  reject(requests[1]!.response);
  expect(await second).toBe('rotated-access');
  const current = await readConnection(connection.id);
  expect(current?.authStatus).toBe('authenticated');
  expect(decryptText(current!.refreshToken!)).toBe('rotated-refresh');
  expect(await getValidAccessToken(connection.id, mcpUrl)).toBe(
    'rotated-access',
  );
  expect(requests).toHaveLength(2);
});

it('preserves reconnected credentials even when the provider reuses its refresh token', async () => {
  const connection = await createConnection();
  respond = () => {};
  const staleAttempt = getValidAccessToken(connection.id, mcpUrl);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await storeTokens(connection.id, {
    access_token: 'reconnected-access',
    refresh_token: 'old-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
  });
  reject(requests[0]!.response);
  expect(await staleAttempt).toBe('reconnected-access');
  expect((await readConnection(connection.id))?.authStatus).toBe(
    'authenticated',
  );
});

it('keeps transient provider failures retryable', async () => {
  const connection = await createConnection();
  respond = (response) =>
    reply(response, { error: 'temporarily_unavailable' }, 503);
  expect(await getValidAccessToken(connection.id, mcpUrl)).toBe('old-access');
  expect(await getValidAccessToken(connection.id, mcpUrl)).toBe('old-access');
  expect(requests).toHaveLength(2);
  expect((await readConnection(connection.id))?.authStatus).toBe(
    'authenticated',
  );
});

it('omits a rejected connection from real MCP config builds until it is reconnected', async () => {
  vi.stubGlobal(
    'fetch',
    (input: string | URL | Request, init?: RequestInit) => {
      if (
        String(input) ===
        'https://mcp.monday.com/.well-known/oauth-authorization-server'
      ) {
        return Promise.resolve(
          Response.json({
            authorization_endpoint: 'https://mcp.monday.com/authorize',
            token_endpoint: 'https://oauth.example.test/token',
          }),
        );
      }
      expect(String(input)).toBe('https://oauth.example.test/token');
      return nativeFetch(providerUrl, init);
    },
  );
  const previous = await db.query.deploymentMcpEnablements.findFirst({
    where: eq(deploymentMcpEnablements.mcpId, 'monday'),
  });
  await db
    .insert(deploymentMcpEnablements)
    .values({ mcpId: 'monday', enabled: true })
    .onConflictDoUpdate({
      target: deploymentMcpEnablements.mcpId,
      set: { enabled: true },
    });
  try {
    const connection = await createConnection('monday');
    const resolve = () =>
      resolveUserMcpServerConfigs({
        userId,
        apiBaseUrl: 'http://localhost:13540',
        includeRoomoteMemberTools: false,
      });
    expect(await resolve()).not.toHaveProperty('monday');
    expect(await resolve()).not.toHaveProperty('monday');
    expect(requests).toHaveLength(1);
    expect((await readConnection(connection.id))?.authStatus).toBe('error');
    await storeTokens(connection.id, {
      access_token: 'reconnected-access',
      refresh_token: 'reconnected-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    expect(await resolve()).toHaveProperty('monday');
    expect(requests).toHaveLength(1);
  } finally {
    if (previous) {
      await db
        .update(deploymentMcpEnablements)
        .set({ enabled: previous.enabled })
        .where(eq(deploymentMcpEnablements.mcpId, 'monday'));
    } else {
      await db
        .delete(deploymentMcpEnablements)
        .where(eq(deploymentMcpEnablements.mcpId, 'monday'));
    }
  }
});
