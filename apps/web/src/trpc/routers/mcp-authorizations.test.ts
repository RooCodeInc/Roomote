import { randomUUID } from 'node:crypto';
import { db, eq, userFactory, users } from '@roomote/db/server';
import {
  createMcpOAuthCode,
  getMcpOAuthCode,
  exchangeMcpOAuthCode,
  isMcpOAuthGrantLive,
  revokeMcpOAuthGrants,
} from '@roomote/redis';
import type { UserAuthSuccess } from '@/types';

vi.mock('@/lib/server', () => ({ authorize: vi.fn() }));
import { mcpAuthorizationsRouter } from './mcp-authorizations';

describe('MCP authorization ownership with real Redis and member fixtures', () => {
  const actors: UserAuthSuccess[] = [];
  async function actor(role: 'admin' | 'member') {
    const user = await userFactory.create({ role });
    const auth = {
      success: true,
      userType: 'user',
      userId: user.id,
      isAdmin: role === 'admin',
    } as UserAuthSuccess;
    actors.push(auth);
    return auth;
  }
  const caller = (auth: UserAuthSuccess) =>
    mcpAuthorizationsRouter.createCaller({ auth });
  async function grant(auth: UserAuthSuccess, clientId: string) {
    const code = await createMcpOAuthCode({
      userId: auth.userId,
      clientId,
      resource: 'https://example.com/mcp',
      scopes: ['mcp:roomote'],
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
    });
    const value = (await getMcpOAuthCode(code))!;
    await exchangeMcpOAuthCode(code, value, true);
    return value;
  }
  afterEach(async () => {
    for (const a of actors.splice(0)) {
      await revokeMcpOAuthGrants(a.userId);
      await db.delete(users).where(eq(users.id, a.userId));
    }
  });
  it('allows own and admin actions and denies cross-user reads, single and bulk revoke', async () => {
    const member = await actor('member');
    const other = await actor('member');
    const admin = await actor('admin');
    const clientId = randomUUID();
    const a = await grant(member, clientId);
    const b = await grant(other, clientId);
    expect(await caller(member).list({})).toMatchObject([
      { grantId: a.grantId },
    ]);
    expect(await caller(admin).list({ userId: other.userId })).toMatchObject([
      { grantId: b.grantId },
    ]);
    await expect(
      caller(member).list({ userId: other.userId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(member).revoke({ userId: other.userId, grantId: b.grantId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(member).revokeAll({ userId: other.userId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A guessed grant ID under one's own target is harmless.
    await caller(member).revoke({ grantId: b.grantId });
    expect(await isMcpOAuthGrantLive(b)).toBe(true);
    await caller(admin).revokeAll({ userId: member.userId });
    expect(await isMcpOAuthGrantLive(a)).toBe(false);
    expect(await isMcpOAuthGrantLive(b)).toBe(true);
    await caller(other).revoke({ grantId: b.grantId });
    expect(await isMcpOAuthGrantLive(b)).toBe(false);
  });
  it('rejects unauthenticated callers', async () => {
    const anonymous = mcpAuthorizationsRouter.createCaller({
      auth: { success: false, error: 'not signed in' },
    });
    await expect(anonymous.list({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
