import { NextResponse } from 'next/server';
import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildBitbucketOAuthRedirectUri,
  createBitbucketOAuthAuthorizationUrl,
} from '@roomote/bitbucket';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
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
  const response = NextResponse.redirect(url);
  response.cookies.set('roomote-bitbucket-oauth-state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: publicAppUrl.startsWith('https://'),
    path: '/api/source-control/bitbucket/oauth',
    maxAge: 600,
  });
  return response;
}
