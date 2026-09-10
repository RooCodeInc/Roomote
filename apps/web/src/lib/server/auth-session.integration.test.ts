import 'next/dist/server/node-environment';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import {
  workAsyncStorage,
  type WorkStore,
} from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { NextRequest } from 'next/server';
import { authSessions, authUsers, db, eq } from '@roomote/db/server';

vi.mock('./bootstrap-runtime-env', () => ({ bootstrapWebRuntimeEnv: vi.fn() }));
vi.mock('./auth-provider-config', () => ({
  resolveAuthProviderConfig: vi.fn(async () => ({ signature: 'session-test' })),
}));
vi.mock('./better-auth-base-url', () => ({
  getBetterAuthBaseUrlConfig: () => 'https://auth.example.test',
}));
vi.mock('./env', () => ({
  Env: { R_APP_URL: 'https://auth.example.test' },
  getBetterAuthSecret: () => 'test-session-signing-secret-not-for-production',
}));
vi.mock('./access-policy', () => ({
  isNewAuthUserEmailAllowed: async () => true,
  isSignInAllowedByAccessPolicy: async () => true,
  // Stop after the real session lookup; admission is covered separately.
  evaluateSignInAccess: async () => ({ allowed: false }),
}));
vi.mock('./license', () => ({ hasSeatAvailable: async () => true }));
vi.mock('./invite-context', () => ({
  extractInviteTokenFromRequest: () => null,
  runWithInviteContext: (_token: unknown, callback: () => unknown) =>
    callback(),
}));

import { getAuth } from './auth';
import { getSignedInAuthContext } from './auth-context';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-10T12:00:00Z');
const COOKIE_NAME = '__Secure-better-auth.session_token';

describe('browser session renewal with real Better Auth, Next cookies and Postgres', () => {
  let cookie: string;
  let userId: string;
  let sessionId: string;

  async function sessionRow() {
    return db.query.authSessions.findFirst({
      where: eq(authSessions.id, sessionId),
    });
  }

  // HTML document renders have no RSC header. Use Next's actual read-only
  // render phase and mutable Route Handler phase, not a mocked cookie setter.
  async function inRequest<T>(
    phase: 'render' | 'action',
    callback: () => Promise<T>,
    rsc = false,
  ) {
    const url = new URL('https://auth.example.test/sessions');
    const headers = new Headers({ cookie });
    if (rsc) headers.set('RSC', '1');
    const request = new NextRequest(url, { headers });
    const outgoing: string[] = [];
    const store = createRequestStoreForAPI(
      request,
      url,
      { tags: [], expirationsByCacheKind: new Map() },
      (cookies) => {
        outgoing.splice(0, outgoing.length, ...cookies);
      },
      undefined,
      undefined,
    );
    store.phase = phase;
    const result = await workAsyncStorage.run(
      { route: '/sessions', isStaticGeneration: false } as WorkStore,
      () => workUnitAsyncStorage.run(store, callback),
    );
    return { result, outgoing };
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const auth = await getAuth();
    const response = await auth.handler(
      new Request('https://auth.example.test/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://auth.example.test',
        },
        body: JSON.stringify({
          name: 'Session Test',
          email: `${crypto.randomUUID()}@example.test`,
          password: 'test-password-123',
        }),
      }),
    );
    expect(response.status).toBe(200);
    userId = (await response.json()).user.id;
    cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${COOKIE_NAME}=`))!
      .split(';')[0]!;
    const row = await db.query.authSessions.findFirst({
      where: eq(authSessions.userId, userId),
    });
    sessionId = row!.id;
  });

  afterEach(async () => {
    await db.delete(authUsers).where(eq(authUsers.id, userId));
    vi.useRealTimers();
  });

  it('creates 30-day sessions and retains secure host-only cookies', async () => {
    expect((await sessionRow())?.expiresAt).toEqual(
      new Date(NOW.getTime() + 30 * DAY),
    );
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    const { outgoing } = await inRequest('action', () =>
      getSignedInAuthContext({ allowSessionRefresh: true }),
    );
    const renewed = outgoing.find((value) =>
      value.startsWith(`${COOKIE_NAME}=`),
    )!;
    expect(renewed).toContain('Max-Age=2592000');
    expect(renewed).toContain('HttpOnly');
    expect(renewed).toContain('Secure');
    expect(renewed.toLowerCase()).toContain('samesite=lax');
    expect(renewed).toContain('Path=/');
    expect(renewed.toLowerCase()).not.toContain('domain=');
  });

  it.each([false, true])(
    'leaves a legacy session due during rendering (RSC=%s), then renews DB and cookie together',
    async (rsc) => {
      const oldExpiry = new Date(NOW.getTime() + 3 * DAY);
      await db
        .update(authSessions)
        .set({ expiresAt: oldExpiry })
        .where(eq(authSessions.id, sessionId));
      const render = await inRequest(
        'render',
        () => getSignedInAuthContext(),
        rsc,
      );
      expect(render.outgoing).toEqual([]);
      expect((await sessionRow())?.expiresAt).toEqual(oldExpiry);

      const route = await inRequest('action', () =>
        getSignedInAuthContext({ allowSessionRefresh: true }),
      );
      expect((await sessionRow())?.expiresAt).toEqual(
        new Date(NOW.getTime() + 30 * DAY),
      );
      expect(
        route.outgoing.some((value) => value.includes('Max-Age=2592000')),
      ).toBe(true);

      const secondTab = await inRequest('action', () =>
        getSignedInAuthContext({ allowSessionRefresh: true }),
      );
      expect(secondTab.outgoing).toEqual([]);
      vi.setSystemTime(new Date(NOW.getTime() + DAY));
      const wake = await inRequest('action', () =>
        getSignedInAuthContext({ allowSessionRefresh: true }),
      );
      expect(
        wake.outgoing.some((value) => value.includes('Max-Age=2592000')),
      ).toBe(true);
      expect((await sessionRow())?.expiresAt).toEqual(
        new Date(NOW.getTime() + 31 * DAY),
      );
    },
  );

  it('reproduces the old HTML DB-only renewal to guard the failure scenario', async () => {
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    const auth = await getAuth();
    const render = await inRequest('render', () =>
      auth.api.getSession({ headers: new Headers({ cookie }) }),
    );
    expect(render.result).not.toBeNull();
    expect(render.outgoing).toEqual([]);
    expect((await sessionRow())?.expiresAt).toEqual(
      new Date(NOW.getTime() + 31 * DAY),
    );
    const route = await inRequest('action', () =>
      getSignedInAuthContext({ allowSessionRefresh: true }),
    );
    expect(route.outgoing).toEqual([]);
  });

  it('does not revive expired sessions', async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 31 * DAY));
    const { result } = await inRequest('action', () =>
      getSignedInAuthContext({ allowSessionRefresh: true }),
    );
    expect(result).toEqual({
      success: false,
      error: 'Unauthorized: User required',
    });
    expect(await sessionRow()).toBeUndefined();
  });

  it('honors administrative deletion immediately', async () => {
    await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    const { result } = await inRequest('action', () =>
      getSignedInAuthContext({ allowSessionRefresh: true }),
    );
    expect(result).toEqual({
      success: false,
      error: 'Unauthorized: User required',
    });
  });

  it('explicit logout deletes the session and clears its cookie', async () => {
    const auth = await getAuth();
    const response = await auth.handler(
      new Request('https://auth.example.test/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie, origin: 'https://auth.example.test' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await sessionRow()).toBeUndefined();
    expect(
      response.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith(`${COOKIE_NAME}=`) && value.includes('Max-Age=0'),
        ),
    ).toBe(true);
  });
});
