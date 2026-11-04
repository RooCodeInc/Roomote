import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from '@roomote/redis';

let redis: Redis;
const { createRedis } = vi.hoisted(() => ({ createRedis: vi.fn() }));
vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  createRedis.mockImplementation((path: string) => {
    process.env.REDIS_URL ??= 'redis://127.0.0.1:16379';
    const base = actual.getRedis();
    const isolated = base.duplicate({ path, retryStrategy: () => 20 });
    base.disconnect();
    return isolated;
  });
  return { getRedis: () => redis };
});
import {
  consumeRemoteMcpConsentToken,
  createRemoteMcpConsentToken,
  getRemoteMcpOAuthClient,
  isAllowedOAuthRedirectUri,
  isRemoteMcpRegistrationAllowed,
  promoteRemoteMcpOAuthClient,
  registerRemoteMcpOAuthClient,
  verifyPkceChallenge,
} from './mcp-remote-oauth';

describe('OAuth registration and consent against real Redis', () => {
  let server: ChildProcess;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-registration-'));
    const socket = join(directory, 'redis.sock');
    server = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { stdio: 'ignore' },
    );
    redis = createRedis(socket);
    redis.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', resolve);
      server.once('error', reject);
    });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    redis.disconnect();
    server.kill('SIGTERM');
    await new Promise<void>((resolve) => server.once('exit', () => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps registrations reusable for 90 days and separate from token state', async () => {
    const client = await registerRemoteMcpOAuthClient({
      clientName: 'Client',
      redirectUris: ['https://client.example/callback'],
    });
    expect(await getRemoteMcpOAuthClient(client.clientId)).toEqual(client);
    expect(
      await redis.ttl(`mcp-remote-oauth:client:${client.clientId}`),
    ).toBeLessThanOrEqual(3600);
    expect(await promoteRemoteMcpOAuthClient(client.clientId, 'alice')).toBe(
      true,
    );
    expect(await promoteRemoteMcpOAuthClient(client.clientId, 'bob')).toBe(
      true,
    );
    expect(
      await redis.ttl(`mcp-remote-oauth:client:${client.clientId}`),
    ).toBeGreaterThan(89 * 86400);
    expect(await redis.zcard('mcp-remote-oauth:registered-clients')).toBe(0);
    expect(await promoteRemoteMcpOAuthClient('missing', 'alice')).toBe(false);
  });

  it('bounds pending registration and reclaims expired entries', async () => {
    for (let i = 0; i < 250; i++)
      await registerRemoteMcpOAuthClient({
        redirectUris: ['https://client.example/callback'],
      });
    await expect(
      registerRemoteMcpOAuthClient({
        redirectUris: ['https://client.example/callback'],
      }),
    ).rejects.toThrow('capacity');
    const [id] = await redis.zrange(
      'mcp-remote-oauth:registered-clients',
      0,
      0,
    );
    await redis.zadd('mcp-remote-oauth:registered-clients', 1, id!);
    await expect(
      registerRemoteMcpOAuthClient({
        redirectUris: ['https://client.example/callback'],
      }),
    ).resolves.toBeDefined();
  });

  it('binds consent to user and request and consumes it once', async () => {
    const binding = {
      userId: 'alice',
      requestTarget: '/authorize?bound=request',
    };
    const token = await createRemoteMcpConsentToken(binding);
    expect(
      await consumeRemoteMcpConsentToken(token, { ...binding, userId: 'bob' }),
    ).toBe(false);
    expect(await consumeRemoteMcpConsentToken(token, binding)).toBe(true);
    expect(await consumeRemoteMcpConsentToken(token, binding)).toBe(false);
  });

  it('enforces per-client and global registration rate limits', async () => {
    for (let i = 0; i < 20; i++)
      expect(await isRemoteMcpRegistrationAllowed('caller')).toBe(true);
    expect(await isRemoteMcpRegistrationAllowed('caller')).toBe(false);
    for (let i = 0; i < 80; i++)
      expect(await isRemoteMcpRegistrationAllowed(`caller-${i}`)).toBe(true);
    expect(await isRemoteMcpRegistrationAllowed('overflow')).toBe(false);
  });
});

describe('OAuth callback and PKCE validation', () => {
  it.each([
    'http://localhost:43110/callback',
    'http://127.0.0.1:43110/callback',
    'http://127.42.10.9:43110/callback',
    'http://[::1]:43110/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'codex://connector/oauth_callback',
    'https://www.cursor.com/agents/mcp/oauth/callback',
    'com.example.app:/oauth2redirect/roomote',
    'example-app:/oauth/callback?connection=roomote',
  ])('accepts supported callback %s', (uri) =>
    expect(isAllowedOAuthRedirectUri(uri)).toBe(true),
  );
  it.each([
    'chrome-extension://extension-id/oauth/callback',
    'moz-extension://extension-id/oauth/callback',
    'safari-web-extension://extension-id/oauth/callback',
    'ms-browser-extension://extension-id/oauth/callback',
    'extension:/oauth/callback',
    'http://client.example/callback',
    'http://0.0.0.0:43110/callback',
    'http://[::2]:43110/callback',
    'example-app:callback',
    'example-app:/',
    'file:///tmp/oauth-callback',
    'javascript:/oauth/callback',
    'data:/oauth/callback',
    'mailto:/oauth/callback',
    'ssh:/oauth/callback',
    'c:/oauth/callback',
    String.raw`https:\\client.example\oauth\callback`,
    ' https://client.example/oauth/callback',
    'example-app://user@example.com/oauth/callback',
    'example-app:/oauth/callback#fragment',
  ])('rejects unsafe callback %s', (uri) =>
    expect(isAllowedOAuthRedirectUri(uri)).toBe(false),
  );
  it('verifies S256 PKCE challenges', () => {
    expect(verifyPkceChallenge('verifier', 'wrong')).toBe(false);
    expect(
      verifyPkceChallenge(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(false);
    expect(
      verifyPkceChallenge(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(true);
  });
});
