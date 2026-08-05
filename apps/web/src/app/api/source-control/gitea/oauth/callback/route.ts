import { type NextRequest, NextResponse } from 'next/server';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildGiteaOAuthRedirectUri,
  exchangeGiteaOAuthCode,
  resolveGiteaBaseUrl,
} from '@roomote/gitea';
import { authorize, getCallbackHost } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getSetupBootstrapState } from '@/lib/server/setup-bootstrap-state';
import { syncRepositoriesCommand } from '@/trpc/commands/source-control';
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
  const callbackOrigin = new URL(getCallbackHost(request)).origin;
  const { setupOpen } = await getSetupBootstrapState();
  const returnTarget = resolveSourceControlOAuthReturnTarget({
    requestedTarget: request.cookies.get(
      getSourceControlOAuthReturnCookieName('gitea'),
    )?.value,
    setupOpen,
  });
  const redirect = new URL(returnTarget, callbackOrigin);
  const response = () => NextResponse.redirect(redirect);
  const clearCookies = (result: NextResponse) => {
    result.cookies.set('roomote-gitea-oauth-state', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: webEnv.R_APP_URL.startsWith('https://'),
      path: '/api/source-control/gitea/oauth',
      maxAge: 0,
    });
    result.cookies.set(getSourceControlOAuthReturnCookieName('gitea'), '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: webEnv.R_APP_URL.startsWith('https://'),
      path: '/api/source-control/gitea/oauth',
      maxAge: 0,
    });
    return result;
  };
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
    return clearCookies(response());
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
    if (!isSetupOAuthReturnTarget(returnTarget)) {
      const syncResult = await syncRepositoriesCommand(authResult, {
        provider: 'gitea',
      });
      if (!syncResult.success) {
        throw new Error(syncResult.error);
      }
    }
    const resultTarget = addSourceControlOAuthResult(
      returnTarget,
      'gitea',
      'connected',
    );
    redirect.href = new URL(resultTarget, callbackOrigin).href;
  } catch (error) {
    console.error('[Gitea OAuth] callback failed', error);
    const resultTarget = addSourceControlOAuthResult(
      returnTarget,
      'gitea',
      'error',
    );
    redirect.href = new URL(resultTarget, callbackOrigin).href;
  }
  return clearCookies(response());
}
