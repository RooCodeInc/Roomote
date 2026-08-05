import { type NextRequest, NextResponse } from 'next/server';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildGiteaOAuthRedirectUri,
  createGiteaOAuthAuthorizationUrl,
  resolveGiteaBaseUrl,
} from '@roomote/gitea';
import { authorize, getCallbackHost } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import {
  getSourceControlOAuthReturnCookieName,
  normalizeSourceControlOAuthReturnTarget,
  SOURCE_CONTROL_OAUTH_COOKIE_MAX_AGE,
} from '@/lib/server/source-control-oauth-redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authResult = await authorize();
  const webEnv = await bootstrapWebRuntimeEnv();
  if (!authResult.success || !authResult.isAdmin) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const [clientId, baseUrl] = await Promise.all([
    resolveDeploymentEnvVar('GITEA_CLIENT_ID'),
    resolveGiteaBaseUrl(),
  ]);
  if (!clientId || !baseUrl) {
    return NextResponse.json(
      { error: 'Gitea OAuth client ID and base URL are not configured.' },
      { status: 400 },
    );
  }
  const callbackOrigin = new URL(getCallbackHost(request)).origin;
  const redirectUri = buildGiteaOAuthRedirectUri(callbackOrigin);
  const { url, state } = createGiteaOAuthAuthorizationUrl({
    baseUrl,
    clientId,
    redirectUri,
  });
  const response = NextResponse.redirect(url);
  const returnTarget = normalizeSourceControlOAuthReturnTarget(
    request.nextUrl.searchParams.get('redirectTo'),
  );
  response.cookies.set('roomote-gitea-oauth-state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: webEnv.R_APP_URL.startsWith('https://'),
    path: '/api/source-control/gitea/oauth',
    maxAge: SOURCE_CONTROL_OAUTH_COOKIE_MAX_AGE,
  });
  response.cookies.set(
    getSourceControlOAuthReturnCookieName('gitea'),
    returnTarget ?? '',
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: webEnv.R_APP_URL.startsWith('https://'),
      path: '/api/source-control/gitea/oauth',
      maxAge: SOURCE_CONTROL_OAUTH_COOKIE_MAX_AGE,
    },
  );
  return response;
}
