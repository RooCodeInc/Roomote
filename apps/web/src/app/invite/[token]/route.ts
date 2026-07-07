import { NextResponse } from 'next/server';

import { INVITE_COOKIE_NAME } from '@/lib/server/invite-context';

const INVITE_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Invite links land here. The token moves into a cookie so it survives the
 * whole sign-up flow (including OAuth redirects), then the visitor continues
 * to sign-in where every configured method — including email/password — can
 * redeem it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Relative Location keeps the redirect on whatever public origin served
  // the invite; deriving an absolute URL from the request would bounce to
  // the internal host when the app sits behind a proxy or tunnel that
  // rewrites the Host header.
  const response = new NextResponse(null, {
    status: 307,
    headers: { Location: '/sign-in?invited=1' },
  });

  response.cookies.set(INVITE_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}
