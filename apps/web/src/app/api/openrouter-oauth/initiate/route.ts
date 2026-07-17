import { NextResponse } from 'next/server';

import {
  generateCodeVerifier,
  generateCodeChallenge,
} from '@roomote/sdk/server';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import {
  OPENROUTER_OAUTH_COOKIE_MAX_AGE_SECONDS,
  OPENROUTER_OAUTH_COOKIE_PATH,
  OPENROUTER_OAUTH_VERIFIER_COOKIE,
  buildOpenRouterAuthorizationUrl,
} from '@/lib/server/openrouter-oauth';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

function withSetupRedirect(
  webUrl: string,
  status: 'connected' | 'error',
  reason?: string,
) {
  const url = new URL('/setup', webUrl);
  url.searchParams.set('step', 'env-vars');
  url.searchParams.set('openrouter', status);
  if (reason) {
    url.searchParams.set('reason', reason);
  }
  return url;
}

export async function GET() {
  const webEnv = await bootstrapWebRuntimeEnv();
  const publicAppUrl = getPublicAppUrl(webEnv);

  const authResult = await authorize();
  if (!authResult.success || !authResult.isAdmin) {
    return NextResponse.redirect(
      withSetupRedirect(publicAppUrl, 'error', 'unauthorized'),
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const authorizationUrl = buildOpenRouterAuthorizationUrl({
    callbackUrl: new URL(
      '/api/openrouter-oauth/callback',
      publicAppUrl,
    ).toString(),
    codeChallenge,
  });

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(OPENROUTER_OAUTH_VERIFIER_COOKIE, codeVerifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: publicAppUrl.startsWith('https://'),
    path: OPENROUTER_OAUTH_COOKIE_PATH,
    maxAge: OPENROUTER_OAUTH_COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}
