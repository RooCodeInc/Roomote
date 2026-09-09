import { NextRequest, NextResponse } from 'next/server';
import { beginConnectionAttempt } from '@/lib/server/source-control-connection-attempt';
import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  BITBUCKET_OAUTH_CALLBACK_PATH,
  buildBitbucketOAuthRedirectUri,
  createBitbucketOAuthAuthorizationUrl,
} from '@roomote/bitbucket';
import { authorize } from '@/lib/server';
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
  const clientId = await resolveDeploymentEnvVar('BITBUCKET_CLIENT_ID');
  if (!clientId) {
    return NextResponse.json(
      { error: 'Bitbucket OAuth consumer ID is not configured.' },
      { status: 400 },
    );
  }
  const publicAppUrl = webEnv.R_PUBLIC_URL ?? webEnv.R_APP_URL;
  const { url, state } = createBitbucketOAuthAuthorizationUrl({
    clientId,
    redirectUri: buildBitbucketOAuthRedirectUri(publicAppUrl),
  });
  const authorizationUrl = new URL(url);
  try {
    authorizationUrl.searchParams.set(
      'state',
      await beginConnectionAttempt(authResult, {
        provider: 'bitbucket',
        requestId:
          request.nextUrl.searchParams.get('connectionRequestId') ?? undefined,
        returnTarget: request.nextUrl.searchParams.get('redirectTo'),
      }),
    );
  } catch {
    return NextResponse.json(
      { error: 'Connection request is unavailable.' },
      { status: 400 },
    );
  }
  const response = NextResponse.redirect(authorizationUrl);
  const returnTarget = normalizeSourceControlOAuthReturnTarget(
    request.nextUrl.searchParams.get('redirectTo'),
  );
  response.cookies.set('roomote-bitbucket-oauth-state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: publicAppUrl.startsWith('https://'),
    path: BITBUCKET_OAUTH_CALLBACK_PATH,
    maxAge: SOURCE_CONTROL_OAUTH_COOKIE_MAX_AGE,
  });
  response.cookies.set(
    getSourceControlOAuthReturnCookieName('bitbucket'),
    returnTarget ?? '',
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicAppUrl.startsWith('https://'),
      path: BITBUCKET_OAUTH_CALLBACK_PATH,
      maxAge: SOURCE_CONTROL_OAUTH_COOKIE_MAX_AGE,
    },
  );
  return response;
}
