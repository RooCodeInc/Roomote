import { type NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import {
  OPENROUTER_OAUTH_COOKIE_PATH,
  OPENROUTER_OAUTH_VERIFIER_COOKIE,
  exchangeOpenRouterCodeForApiKey,
} from '@/lib/server/openrouter-oauth';
import { saveSetupNewModelConfigCommand } from '@/trpc/commands/setup-new';

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

  const response = NextResponse.redirect(url);
  // The one-time verifier is no longer needed after the callback runs.
  response.cookies.set(OPENROUTER_OAUTH_VERIFIER_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: webUrl.startsWith('https://'),
    path: OPENROUTER_OAUTH_COOKIE_PATH,
    maxAge: 0,
  });

  return response;
}

export async function GET(request: NextRequest) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const webUrl = webEnv.R_APP_URL;

  const code = request.nextUrl.searchParams.get('code');
  const oauthError = request.nextUrl.searchParams.get('error');
  const oauthErrorDescription =
    request.nextUrl.searchParams.get('error_description');
  const codeVerifier =
    request.cookies.get(OPENROUTER_OAUTH_VERIFIER_COOKIE)?.value ?? null;

  // Handle an explicit OAuth error (e.g. the admin cancelled or denied
  // authorization) before treating the missing code as an anomaly.
  if (oauthError) {
    console.error(
      '[OpenRouter OAuth] OAuth error:',
      oauthError,
      oauthErrorDescription,
    );
    return withSetupRedirect(webUrl, 'error', 'access_denied');
  }

  const authResult = await authorize();
  if (!authResult.success || !authResult.isAdmin) {
    return withSetupRedirect(webUrl, 'error', 'unauthorized');
  }

  if (!code) {
    return withSetupRedirect(webUrl, 'error', 'missing_code');
  }

  if (!codeVerifier) {
    return withSetupRedirect(webUrl, 'error', 'missing_verifier');
  }

  try {
    const apiKey = await exchangeOpenRouterCodeForApiKey({
      code,
      codeVerifier,
    });

    await saveSetupNewModelConfigCommand(authResult, {
      provider: 'openrouter',
      apiKey,
    });

    return withSetupRedirect(webUrl, 'connected');
  } catch (error) {
    console.error('[OpenRouter OAuth] Error in callback:', error);
    return withSetupRedirect(webUrl, 'error', 'exchange_failed');
  }
}
