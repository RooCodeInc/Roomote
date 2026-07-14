import { type NextRequest, NextResponse } from 'next/server';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildGitLabOAuthRedirectUri,
  exchangeGitLabOAuthCode,
  resolveGitLabBaseUrl,
} from '@roomote/gitlab';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const redirect = new URL('/setup', webEnv.R_APP_URL);
  redirect.searchParams.set('step', 'source-control-connect');
  const response = () => NextResponse.redirect(redirect);
  const authResult = await authorize();
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = request.cookies.get(
    'roomote-gitlab-oauth-state',
  )?.value;
  const code = request.nextUrl.searchParams.get('code');
  if (
    !authResult.success ||
    !authResult.isAdmin ||
    !state ||
    state !== expectedState ||
    !code
  ) {
    redirect.searchParams.set('gitlab', 'error');
    return response();
  }
  try {
    const [baseUrl, clientId, clientSecret] = await Promise.all([
      resolveGitLabBaseUrl(),
      resolveDeploymentEnvVar('GITLAB_CLIENT_ID'),
      resolveDeploymentEnvVar('GITLAB_CLIENT_SECRET'),
    ]);
    if (!clientId || !clientSecret)
      throw new Error('GitLab OAuth client credentials are not configured.');
    await exchangeGitLabOAuthCode({
      baseUrl,
      clientId,
      clientSecret,
      code,
      redirectUri: buildGitLabOAuthRedirectUri(webEnv.R_APP_URL),
    });
    redirect.searchParams.set('gitlab', 'connected');
  } catch (error) {
    console.error('[GitLab OAuth] callback failed', error);
    redirect.searchParams.set('gitlab', 'error');
  }
  const result = response();
  result.cookies.set('roomote-gitlab-oauth-state', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: webEnv.R_APP_URL.startsWith('https://'),
    path: '/api/source-control/gitlab/oauth',
    maxAge: 0,
  });
  return result;
}
