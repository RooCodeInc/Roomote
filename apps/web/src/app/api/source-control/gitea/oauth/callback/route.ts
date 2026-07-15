import { type NextRequest, NextResponse } from 'next/server';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildGiteaOAuthRedirectUri,
  exchangeGiteaOAuthCode,
  resolveGiteaBaseUrl,
} from '@roomote/gitea';
import { authorize, getCallbackHost } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const callbackOrigin = new URL(getCallbackHost(request)).origin;
  const redirect = new URL('/setup', callbackOrigin);
  redirect.searchParams.set('step', 'source-control-connect');
  const response = () => NextResponse.redirect(redirect);
  const authResult = await authorize();
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = request.cookies.get('roomote-gitea-oauth-state')?.value;
  const code = request.nextUrl.searchParams.get('code');
  if (
    !authResult.success ||
    !authResult.isAdmin ||
    !state ||
    state !== expectedState ||
    !code
  ) {
    redirect.searchParams.set('gitea', 'error');
    return response();
  }
  try {
    const [baseUrl, clientId, clientSecret] = await Promise.all([
      resolveGiteaBaseUrl(),
      resolveDeploymentEnvVar('GITEA_CLIENT_ID'),
      resolveDeploymentEnvVar('GITEA_CLIENT_SECRET'),
    ]);
    if (!baseUrl || !clientId || !clientSecret) {
      throw new Error('Gitea OAuth client credentials are not configured.');
    }
    await exchangeGiteaOAuthCode({
      baseUrl,
      clientId,
      clientSecret,
      code,
      redirectUri: buildGiteaOAuthRedirectUri(callbackOrigin),
    });
    redirect.searchParams.set('gitea', 'connected');
    redirect.searchParams.set('sync', '1');
  } catch (error) {
    console.error('[Gitea OAuth] callback failed', error);
    redirect.searchParams.set('gitea', 'error');
  }
  const result = response();
  result.cookies.set('roomote-gitea-oauth-state', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: webEnv.R_APP_URL.startsWith('https://'),
    path: '/api/source-control/gitea/oauth',
    maxAge: 0,
  });
  return result;
}
