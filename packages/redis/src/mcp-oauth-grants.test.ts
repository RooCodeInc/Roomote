import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';

let redis: Redis;
vi.mock('./client', () => ({ getMcpOAuthRedis: () => redis }));

import {
  createMcpOAuthCode,
  getMcpOAuthCode,
  exchangeMcpOAuthCode,
  getMcpOAuthRefresh,
  rotateMcpOAuthRefresh,
  revokeMcpOAuthRefresh,
  isMcpOAuthGrantLive,
  listMcpOAuthGrants,
  revokeMcpOAuthGrants,
} from './mcp-oauth-grants';

const prefix = 'mcp-remote-oauth:grants:v2:';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const auth = (userId = 'alice', clientId = 'shared-client') => ({
  userId,
  clientId,
  resource: 'https://example.com/mcp',
  scopes: ['mcp:roomote'],
  redirectUri: 'https://client.example/callback',
  codeChallenge: 'pkce',
});
async function authorize(
  userId = 'alice',
  clientId = 'shared-client',
  refresh = true,
) {
  const code = await createMcpOAuthCode(auth(userId, clientId), '<Client>');
  const grant = (await getMcpOAuthCode(code))!;
  const result = (await exchangeMcpOAuthCode(code, grant, refresh))!;
  return { code, grant, ...result };
}

describe('MCP grants against real Redis Lua', () => {
  let server: ChildProcess;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-grants-'));
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
    redis = new Redis({ path: socket, retryStrategy: () => 20 });
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

  it('tracks code-only grants from consent, exchanges once and expires without a refresh token', async () => {
    const code = await createMcpOAuthCode(auth(), 'Client\nname');
    expect(await listMcpOAuthGrants('alice')).toMatchObject([
      { clientName: 'Clientname', status: 'pending', lastUsedAt: null },
    ]);
    const grant = (await getMcpOAuthCode(code))!;
    expect(await isMcpOAuthGrantLive(grant)).toBe(false);
    expect(await exchangeMcpOAuthCode(code, grant, false)).toEqual({
      refreshToken: undefined,
    });
    expect(await exchangeMcpOAuthCode(code, grant, false)).toBeNull();
    expect(await isMcpOAuthGrantLive(grant)).toBe(true);
    expect(await listMcpOAuthGrants('alice')).toMatchObject([
      {
        status: 'active',
        lastUsedAt: expect.any(Number),
        lastTokenAt: expect.any(Number),
      },
    ]);
    expect(
      await redis.ttl(`${prefix}grant:${grant.grantId}`),
    ).toBeLessThanOrEqual(3600);
    await redis.del(`${prefix}grant:${grant.grantId}`);
    expect(await isMcpOAuthGrantLive(grant)).toBe(false);
    expect(await listMcpOAuthGrants('alice')).toEqual([]);
  });

  it('isolates users sharing registration and makes revoke idempotent and generation-bound', async () => {
    await redis.set('mcp-remote-oauth:client:shared-client', 'registration');
    const a = await authorize();
    const b = await authorize('bob');
    await revokeMcpOAuthGrants('bob', a.grant.grantId);
    expect(await isMcpOAuthGrantLive(a.grant)).toBe(true);
    await revokeMcpOAuthGrants('alice', a.grant.grantId);
    await revokeMcpOAuthGrants('alice', a.grant.grantId);
    expect(await isMcpOAuthGrantLive(a.grant)).toBe(false);
    expect(await getMcpOAuthRefresh(a.refreshToken!)).toBeNull();
    const next = await authorize();
    expect(await isMcpOAuthGrantLive(next.grant)).toBe(true);
    expect(await isMcpOAuthGrantLive(a.grant)).toBe(false);
    expect(await isMcpOAuthGrantLive(b.grant)).toBe(true);
    expect(await redis.get('mcp-remote-oauth:client:shared-client')).toBe(
      'registration',
    );
  });

  it('revokes pending codes and all clients only for the selected user', async () => {
    const a = await authorize();
    const code = await createMcpOAuthCode(auth('alice', 'code-only'));
    const pending = (await getMcpOAuthCode(code))!;
    const b = await authorize('bob');
    await revokeMcpOAuthGrants('alice');
    expect(await listMcpOAuthGrants('alice')).toEqual([]);
    expect(await exchangeMcpOAuthCode(code, pending, true)).toBeNull();
    expect(await isMcpOAuthGrantLive(a.grant)).toBe(false);
    expect(await isMcpOAuthGrantLive(b.grant)).toBe(true);
  });

  it('never resurrects a grant when revoke races a code exchange or refresh', async () => {
    for (let i = 0; i < 20; i++) {
      const code = await createMcpOAuthCode(auth());
      const grant = (await getMcpOAuthCode(code))!;
      await Promise.all([
        exchangeMcpOAuthCode(code, grant, true),
        revokeMcpOAuthGrants('alice', grant.grantId),
      ]);
      expect(await isMcpOAuthGrantLive(grant)).toBe(false);
      const active = await authorize();
      await Promise.all([
        rotateMcpOAuthRefresh(active.refreshToken!, active.grant),
        revokeMcpOAuthGrants('alice'),
      ]);
      expect(await isMcpOAuthGrantLive(active.grant)).toBe(false);
    }
  });

  it('handles rotation, replay, unknown tokens and RFC7009 revocation with client isolation', async () => {
    const { grant, refreshToken } = await authorize();
    const rotated = await rotateMcpOAuthRefresh(refreshToken!, grant);
    expect(rotated.status).toBe('ok');
    expect(await getMcpOAuthRefresh(refreshToken!)).toBeNull();
    await revokeMcpOAuthRefresh(rotated.refreshToken, 'different-client');
    await revokeMcpOAuthRefresh(`${grant.grantId}.${'a'.repeat(64)}`);
    expect(await isMcpOAuthGrantLive(grant)).toBe(true);
    await revokeMcpOAuthRefresh(refreshToken!, grant.clientId);
    expect(await getMcpOAuthRefresh(rotated.refreshToken)).toBeNull();
    expect(await isMcpOAuthGrantLive(grant)).toBe(false);
    expect((await rotateMcpOAuthRefresh(refreshToken!, grant)).status).toBe(
      'reuse',
    );
  });

  it('caps pending and active grants together and reclaims expired capacity', async () => {
    for (let i = 0; i < 50; i++)
      await createMcpOAuthCode(auth('alice', `client-${i}`));
    await expect(createMcpOAuthCode(auth('alice', 'overflow'))).rejects.toThrow(
      'capacity',
    );
    const all = await listMcpOAuthGrants('alice');
    const id = all[0]!.grantId;
    await redis.del(`${prefix}grant:${id}`);
    await redis.zadd(`${prefix}user:${hash('alice')}`, 1, id);
    await redis.zadd(`${prefix}all`, 1, id);
    await expect(
      createMcpOAuthCode(auth('alice', 'now-fits')),
    ).resolves.toBeTypeOf('string');
  });

  async function legacy(userId = 'alice', clientId = 'shared-client') {
    const sessionId = randomBytes(32).toString('hex');
    const token = `${sessionId}.${randomBytes(32).toString('base64url')}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const session = {
      sessionId,
      ...auth(userId, clientId),
      currentTokenHash: hash(token),
      expiresAt,
    };
    await redis.set(
      `mcp-remote-oauth:session:${sessionId}`,
      JSON.stringify(session),
      'EX',
      900,
    );
    await redis.set(
      `mcp-remote-oauth:refresh:${hash(token)}`,
      `active:${sessionId}`,
      'EX',
      900,
    );
    await redis.set(
      `mcp-remote-oauth:client-session:${hash(`${userId}\0${clientId}`)}`,
      sessionId,
      'EX',
      900,
    );
    await redis.zadd(
      `mcp-remote-oauth:active-clients:user:${hash(userId)}`,
      expiresAt + 90 * 86400,
      clientId,
    );
    return { token, sessionId, expiresAt };
  }

  it('backfills legacy families with original expiry and unknown historical timestamps', async () => {
    const old = await legacy();
    const [summary] = await listMcpOAuthGrants('alice');
    expect(summary).toMatchObject({
      grantId: old.sessionId,
      authorizedAt: null,
      lastUsedAt: null,
    });
    expect(summary!.expiresAt).toBeLessThanOrEqual(old.expiresAt);
    expect(
      await redis.get(`mcp-remote-oauth:session:${old.sessionId}`),
    ).toBeNull();
    const grant = (await getMcpOAuthRefresh(old.token))!;
    const next = await rotateMcpOAuthRefresh(old.token, grant);
    expect(next.status).toBe('ok');
    expect(await isMcpOAuthGrantLive(grant)).toBe(true);
    await revokeMcpOAuthRefresh(old.token);
    expect(await isMcpOAuthGrantLive(grant)).toBe(false);
  });

  it('blocks unmigrated legacy sessions after bulk revoke, including migration races', async () => {
    const b = await legacy('bob');
    for (let i = 0; i < 10; i++) {
      const a = await legacy();
      await Promise.all([
        getMcpOAuthRefresh(a.token),
        revokeMcpOAuthGrants('alice'),
      ]);
      expect(await getMcpOAuthRefresh(a.token)).toBeNull();
      expect(await listMcpOAuthGrants('alice')).toEqual([]);
    }
    expect(await getMcpOAuthRefresh(b.token)).not.toBeNull();
  });

  it('rejects expired, rotated and unknown legacy sessions without manufacturing a grant', async () => {
    const a = await legacy();
    await redis.set(
      `mcp-remote-oauth:refresh:${hash(a.token)}`,
      `rotated:${a.sessionId}`,
      'EX',
      900,
    );
    expect(await getMcpOAuthRefresh(a.token)).toBeNull();
    expect(await listMcpOAuthGrants('alice')).toEqual([]);
    await redis.del(`mcp-remote-oauth:session:${a.sessionId}`);
    expect(await getMcpOAuthRefresh(a.token)).toBeNull();
    expect(await isMcpOAuthGrantLive({ userId: 'alice' })).toBe(false);
  });

  it('does not accept OAuth when Redis fails', async () => {
    const { grant } = await authorize();
    const failing = vi
      .spyOn(redis, 'eval')
      .mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(isMcpOAuthGrantLive(grant)).rejects.toThrow(
      'Redis unavailable',
    );
    failing.mockRestore();
  });

  it('checks identity and absolute expiry even if Redis has retained the record', async () => {
    const { grant } = await authorize();
    expect(await isMcpOAuthGrantLive({ ...grant, userId: 'bob' })).toBe(false);
    expect(await isMcpOAuthGrantLive({ ...grant, clientId: 'other' })).toBe(
      false,
    );
    const key = `${prefix}grant:${grant.grantId}`;
    const stored = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...stored, expiresAt: 1 }), 'EX', 60);
    expect(await isMcpOAuthGrantLive(grant)).toBe(false);
    expect(await listMcpOAuthGrants('alice')).toEqual([]);
  });

  it('does not revive legacy sessions when consent or single revoke races backfill', async () => {
    const old = await legacy();
    const [rows] = await Promise.all([
      listMcpOAuthGrants('alice'),
      createMcpOAuthCode(auth()),
    ]);
    if (rows[0]) await revokeMcpOAuthGrants('alice', rows[0].grantId);
    expect(await getMcpOAuthRefresh(old.token)).toBeNull();
    const other = await legacy('bob');
    const [summary] = await listMcpOAuthGrants('bob');
    await Promise.all([
      getMcpOAuthRefresh(other.token),
      revokeMcpOAuthGrants('bob', summary!.grantId),
    ]);
    expect(await getMcpOAuthRefresh(other.token)).toBeNull();
  });
});
