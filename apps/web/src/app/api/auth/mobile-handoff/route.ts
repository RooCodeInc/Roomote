import { NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/server';
import { Env } from '@/lib/server/env';
import {
  isAllowedHandoffRedirect,
  storeMobileHandoffToken,
} from '@/lib/server/mobile-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Better Auth names the cookie once at init; production deployments behind
// HTTPS get the __Secure- prefix, everything else does not.
const SESSION_COOKIE_NAMES = [
  '__Secure-better-auth.session_token',
  'better-auth.session_token',
];

/**
 * Hand the browser's session to the native app.
 *
 * Signed out: bounce through the web sign-in and come back here. Signed in:
 * mint a one-time code for the signed session token and redirect to the
 * app's `roomote://auth?code=` URL. See `lib/server/mobile-handoff.ts`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const redirect = request.nextUrl.searchParams.get('redirect') ?? '';
  if (!isAllowedHandoffRedirect(redirect)) {
    return NextResponse.json(
      { error: 'redirect must be a roomote:// URL' },
      { status: 400 },
    );
  }

  const auth = await authorize();
  if (!auth.success) {
    // Behind the app's reverse proxy the request origin can be internal;
    // the configured app URL is what the browser can reach.
    const signIn = new URL('/sign-in', Env.R_APP_URL);
    const returnTo = new URL(request.nextUrl.pathname, Env.R_APP_URL);
    returnTo.searchParams.set('redirect', redirect);
    // The sign-in page honors `redirect_url` for same-origin paths.
    signIn.searchParams.set(
      'redirect_url',
      `${returnTo.pathname}${returnTo.search}`,
    );
    return NextResponse.redirect(signIn, { status: 302 });
  }

  const sessionToken = SESSION_COOKIE_NAMES.map(
    (name) => request.cookies.get(name)?.value,
  ).find((value): value is string => Boolean(value));
  if (!sessionToken) {
    return NextResponse.json(
      { error: 'No session cookie on this request' },
      { status: 401 },
    );
  }

  const code = await storeMobileHandoffToken(sessionToken);
  const target = new URL(redirect);
  target.searchParams.set('code', code);
  return NextResponse.redirect(target, { status: 302 });
}
