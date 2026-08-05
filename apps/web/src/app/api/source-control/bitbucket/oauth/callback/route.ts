import { type NextRequest, NextResponse } from 'next/server';
import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  BITBUCKET_OAUTH_CALLBACK_PATH,
  buildBitbucketOAuthRedirectUri,
  exchangeBitbucketOAuthCode,
} from '@roomote/bitbucket';
import { authorize } from '@/lib/server';
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
  const publicAppUrl = webEnv.R_PUBLIC_URL ?? webEnv.R_APP_URL;
  const { setupOpen } = await getSetupBootstrapState();
  const returnTarget = resolveSourceControlOAuthReturnTarget({
    requestedTarget: request.cookies.get(
      getSourceControlOAuthReturnCookieName('bitbucket'),
    )?.value,
    setupOpen,
  });
  const redirect = new URL(returnTarget, publicAppUrl);
  const response = () => NextResponse.redirect(redirect);
  const clearCookies = (result: NextResponse) => {
    result.cookies.set('roomote-bitbucket-oauth-state', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicAppUrl.startsWith('https://'),
      path: BITBUCKET_OAUTH_CALLBACK_PATH,
      maxAge: 0,
    });
    result.cookies.set(getSourceControlOAuthReturnCookieName('bitbucket'), '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicAppUrl.startsWith('https://'),
      path: BITBUCKET_OAUTH_CALLBACK_PATH,
      maxAge: 0,
    });
    return result;
  };
  const authResult = await authorize();
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = request.cookies.get(
    'roomote-bitbucket-oauth-state',
  )?.value;
  const code = request.nextUrl.searchParams.get('code');
  if (
    !authResult.success ||
    !authResult.isAdmin ||
    !state ||
    state !== expectedState ||
    !code
  ) {
    redirect.searchParams.set('bitbucket', 'error');
    return clearCookies(response());
  }
  try {
    const [clientId, clientSecret] = await Promise.all([
      resolveDeploymentEnvVar('BITBUCKET_CLIENT_ID'),
      resolveDeploymentEnvVar('BITBUCKET_CLIENT_SECRET'),
    ]);
    if (!clientId || !clientSecret)
      throw new Error(
        'Bitbucket OAuth consumer credentials are not configured.',
      );
    await exchangeBitbucketOAuthCode({
      clientId,
      clientSecret,
      code,
      redirectUri: buildBitbucketOAuthRedirectUri(publicAppUrl),
    });
    if (!isSetupOAuthReturnTarget(returnTarget)) {
      await syncRepositoriesCommand(authResult, { provider: 'bitbucket' });
    }
    const resultTarget = addSourceControlOAuthResult(
      returnTarget,
      'bitbucket',
      'connected',
    );
    redirect.href = new URL(resultTarget, publicAppUrl).href;
  } catch (error) {
    console.error('[Bitbucket OAuth] callback failed', error);
    const resultTarget = addSourceControlOAuthResult(
      returnTarget,
      'bitbucket',
      'error',
    );
    redirect.href = new URL(resultTarget, publicAppUrl).href;
  }
  return clearCookies(response());
}
