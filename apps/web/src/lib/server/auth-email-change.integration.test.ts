import { authUsers, db, eq } from '@roomote/db/server';

vi.mock('./bootstrap-runtime-env', () => ({ bootstrapWebRuntimeEnv: vi.fn() }));
vi.mock('./auth-provider-config', () => ({
  resolveAuthProviderConfig: async () => ({ signature: 'email-change-test' }),
}));
vi.mock('./better-auth-base-url', () => ({
  getBetterAuthBaseUrlConfig: () => 'https://auth.example.test',
}));
vi.mock('./env', () => ({
  Env: { R_APP_URL: 'https://auth.example.test' },
  getBetterAuthSecret: () => 'integration-secret-at-least-32-characters',
  isEmailChannelEnabled: () => true,
}));
vi.mock('./access-policy', () => ({
  isNewAuthUserEmailAllowed: async () => true,
  isSignInAllowedByAccessPolicy: async () => true,
}));
vi.mock('@roomote/sdk/server/agentmail-outbound', () => ({
  sendAgentMailSystemEmail: vi.fn(async () => ({ sent: true })),
}));

import { sendAgentMailSystemEmail } from '@roomote/sdk/server/agentmail-outbound';
import { handleAuthRequest } from './auth';

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

function request(path: string, body?: object, cookie = '') {
  return handleAuthRequest(
    new Request(`https://auth.example.test/api/auth/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: 'https://auth.example.test',
        cookie,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function lastVerificationLink() {
  const mail = vi.mocked(sendAgentMailSystemEmail).mock.calls.at(-1)?.[0];
  const link = mail?.text.match(/\[Verify your email\]\(([^)]+)\)/)?.[1];
  if (!link)
    throw new Error('Verification link was not delivered to fixture sender');
  return link;
}

it('binds email-change links to their issuing user after the old address is registered again', async () => {
  const suffix = crypto.randomUUID();
  const oldEmail = `old-${suffix}@example.test`;
  const nextEmail = `next-${suffix}@example.test`;
  const staleTarget = `stale-${suffix}@example.test`;
  const ids: string[] = [];
  const signup = async (email: string) => {
    const response = await request('sign-up/email', {
      email,
      name: 'Email Fixture',
      password: 'Fixture-password-123!',
    });
    expect(response.status).toBe(200);
    const userId = (await response.json()).user.id as string;
    ids.push(userId);
    return { response, userId };
  };
  try {
    const owner = await signup(oldEmail);
    const verified = await handleAuthRequest(
      new Request(lastVerificationLink()),
    );
    expect(verified.status).toBe(302);
    const cookie = cookies(owner.response);
    expect(
      (
        await request(
          'change-email',
          { newEmail: staleTarget, callbackURL: '/sign-in' },
          cookie,
        )
      ).status,
    ).toBe(200);
    const staleLink = lastVerificationLink();
    expect(
      (
        await request(
          'change-email',
          { newEmail: nextEmail, callbackURL: '/sign-in' },
          cookie,
        )
      ).status,
    ).toBe(200);
    const changed = await handleAuthRequest(
      new Request(lastVerificationLink()),
    );
    expect(changed.status).toBe(302);
    expect(
      (
        await db.query.authUsers.findFirst({
          where: eq(authUsers.id, owner.userId),
        })
      )?.email,
    ).toBe(nextEmail);
    const replacement = await signup(oldEmail);
    // Replay without a session, as in the advisory; never receive the replacement's session.
    const replay = await handleAuthRequest(new Request(staleLink));
    expect(replay.headers.get('location')).toContain('error=');
    const session = await request('get-session', undefined, cookies(replay));
    expect(await session.json()).toBeNull();
    expect(
      (
        await db.query.authUsers.findFirst({
          where: eq(authUsers.id, replacement.userId),
        })
      )?.email,
    ).toBe(oldEmail);
    expect(
      (
        await db.query.authUsers.findFirst({
          where: eq(authUsers.id, owner.userId),
        })
      )?.email,
    ).toBe(nextEmail);
  } finally {
    for (const id of ids)
      await db.delete(authUsers).where(eq(authUsers.id, id));
  }
});
