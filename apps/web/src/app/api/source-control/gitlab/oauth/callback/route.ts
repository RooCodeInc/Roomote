import { type NextRequest, NextResponse } from 'next/server';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildGitLabOAuthRedirectUri,
  exchangeGitLabOAuthCode,
  resolveGitLabBaseUrl,
} from '@roomote/gitlab';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getSetupBootstrapState } from '@/lib/server/setup-bootstrap-state';
import { syncRepositoriesCommand } from '@/trpc/commands/source-control';
import { notifySetupSourceControlSynchronized } from '@/trpc/commands/setup/setup-session';
import {
  addSourceControlOAuthResult,
  getSourceControlOAuthReturnCookieName,
  isSetupOAuthReturnTarget,
  resolveSourceControlOAuthReturnTarget,
} from '@/lib/server/source-control-oauth-redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const publicAppUrl = webEnv.R_PUBLIC_URL ?? webEnv.R_APP_URL;
  const { setupOpen } = await getSetupBootstrapState();
  const returnTarget = resolveSourceControlOAuthReturnTarget({
    requestedTarget: request.cookies.get(
      getSourceControlOAuthReturnCookieName('gitlab'),
    )?.value,
    setupOpen,
  });
  const redirect = new URL(returnTarget, publicAppUrl);
  const response = () => NextResponse.redirect(redirect);
  const clearCookies = (result: NextResponse) => {
    result.cookies.set('roomote-gitlab-oauth-state', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicAppUrl.startsWith('https://'),
      path: '/api/source-control/gitlab/oauth',
      maxAge: 0,
    });
    result.cookies.set(getSourceControlOAuthReturnCookieName('gitlab'), '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicAppUrl.startsWith('https://'),
      path: '/api/source-control/gitlab/oauth',
      maxAge: 0,
    });
    return result;
  };
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
    return clearCookies(response());
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
      redirectUri: buildGitLabOAuthRedirectUri(publicAppUrl),
    });
    const syncResult = await syncRepositoriesCommand(authResult, {
      provider: 'gitlab',
    });
    if (!syncResult.success) {
      throw new Error(syncResult.error);
    }
    if (isSetupOAuthReturnTarget(returnTarget))
      await notifySetupSourceControlSynchronized(authResult);
    const resultTarget = addSourceControlOAuthResult(
      returnTarget,
      'gitlab',
      'connected',
    );
    redirect.href = new URL(resultTarget, publicAppUrl).href;
  } catch (error) {
    console.error('[GitLab OAuth] callback failed', error);
    const resultTarget = addSourceControlOAuthResult(
      returnTarget,
      'gitlab',
      'error',
      error instanceof Error ? error.message : 'GitLab authorization failed.',
    );
    redirect.href = new URL(resultTarget, publicAppUrl).href;
  }
  return clearCookies(response());
}
