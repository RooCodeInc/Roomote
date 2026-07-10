import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { authSessions, authUsers, db, eq, users } from '@roomote/db/server';

import { normalizeAuthRedirect } from '@/lib/auth-redirect';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { isRoomoteEmailAllowed } from '@/lib/server/auth-allowlist';
import {
  Env,
  getBetterAuthSecret,
  isWebServerBindExposed,
} from '@/lib/server/env';

export const runtime = 'nodejs';

const DEFAULT_REDIRECT_PATH = '/';
const DEFAULT_DEV_LOGIN_EMAIL = 'local@roomote.dev';
const DEFAULT_DEV_LOGIN_NAME = 'Local Admin';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const DEV_LOGIN_USER_AGENT = 'roomote-dev-login';

function getRequestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();

  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

// Dev login is an unauthenticated admin backdoor, so it must only exist in
// development app envs. APP_ENV=preview covers hosted preview/staging
// deployments, which are internet-facing and must not expose it; sandbox
// previews run `pnpm dev` and resolve to APP_ENV=development. It is also
// disabled on a non-loopback bind as defense-in-depth.
function isDevLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    Env.APP_ENV === 'development' &&
    !isWebServerBindExposed()
  );
}

function getDevLoginIdentity() {
  const email =
    Env.WEB_DEV_LOGIN_EMAIL?.trim().toLowerCase() || DEFAULT_DEV_LOGIN_EMAIL;

  return {
    email,
    id: `dev-login-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
    name: email === DEFAULT_DEV_LOGIN_EMAIL ? DEFAULT_DEV_LOGIN_NAME : email,
  };
}

function signBetterAuthCookieValue(value: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(value).digest('base64');

  return `${value}.${signature}`;
}

// Better Auth determines the session-token cookie name once at init time from
// the baseURL config. With the dynamic baseURL (protocol: "auto") used in
// non-production, the __Secure- prefix is NOT applied — the cookie is always
// "better-auth.session_token" regardless of the request protocol. The Secure
// *attribute* is still set per-request from the forwarded proto, so the
// browser only sends the cookie over HTTPS when appropriate. Using the
// __Secure- prefixed name here would cause Better Auth's getSignedCookie to
// miss the cookie on HTTPS preview proxies.
const SESSION_COOKIE_NAME = 'better-auth.session_token';

export async function GET(request: NextRequest) {
  await bootstrapWebRuntimeEnv();

  if (!isDevLoginEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const appBaseUrl = new URL(getRequestOrigin(request));
  const redirectParam =
    request.nextUrl.searchParams.get('redirect_url') ??
    request.nextUrl.searchParams.get('redirect');
  const redirectPath =
    normalizeAuthRedirect(redirectParam, appBaseUrl.origin) ??
    DEFAULT_REDIRECT_PATH;

  const response = NextResponse.redirect(
    new URL(redirectPath, appBaseUrl.origin),
  );

  const identity = getDevLoginIdentity();
  if (!isRoomoteEmailAllowed(identity.email, Env.R_ALLOWED_EMAILS)) {
    return NextResponse.json(
      {
        error: 'Dev login email is not allowed for this Roomote instance.',
      },
      { status: 403 },
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  const sessionToken = randomBytes(32).toString('base64url');

  await db
    .insert(authUsers)
    .values({
      id: identity.id,
      name: identity.name,
      email: identity.email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.email,
      set: {
        emailVerified: true,
        updatedAt: now,
      },
    });

  const [authUser] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, identity.email))
    .limit(1);

  if (!authUser) {
    return NextResponse.json(
      { error: 'Unable to create dev login user.' },
      { status: 500 },
    );
  }

  // Ensure the app-level users row exists as an active admin. Without it,
  // evaluateSignInAccess() rejects the session whenever another user (e.g.
  // the seeded local-user) already exists, and a fresh row created later by
  // ensureDeploymentIdentity() would only join as a member.
  await db
    .insert(users)
    .values({
      id: authUser.id,
      name: identity.name,
      email: identity.email,
      imageUrl: '',
      entity: {
        id: authUser.id,
        name: identity.name,
        email: identity.email,
        imageUrl: '',
      },
      metadata: {},
      role: 'admin',
      onboardingCompletedAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        role: 'admin',
        deletedAt: null,
        updatedAt: now,
      },
    });

  await db.insert(authSessions).values({
    id: `dev-login-session-${randomUUID()}`,
    userId: authUser.id,
    token: sessionToken,
    expiresAt,
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: request.headers.get('user-agent') ?? DEV_LOGIN_USER_AGENT,
    createdAt: now,
    updatedAt: now,
  });

  const isSecureRequest = appBaseUrl.protocol === 'https:';

  response.cookies.set(
    SESSION_COOKIE_NAME,
    signBetterAuthCookieValue(sessionToken, getBetterAuthSecret()),
    {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'lax',
      secure: isSecureRequest,
    },
  );
  response.cookies.delete('better-auth.session_data');
  response.cookies.delete('__Secure-better-auth.session_data');

  return response;
}
