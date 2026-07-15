import { NextResponse } from 'next/server';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  buildGitLabOAuthRedirectUri,
  createGitLabOAuthAuthorizationUrl,
  resolveGitLabBaseUrl,
} from '@roomote/gitlab';
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
  const [clientId, baseUrl] = await Promise.all([
    resolveDeploymentEnvVar('GITLAB_CLIENT_ID'),
    resolveGitLabBaseUrl(),
  ]);
  if (!clientId)
    return NextResponse.json(
      { error: 'GitLab OAuth client ID is not configured.' },
      { status: 400 },
    );

  const publicAppUrl = webEnv.R_PUBLIC_URL ?? webEnv.R_APP_URL;
  const redirectUri = buildGitLabOAuthRedirectUri(publicAppUrl);
  const { url, state } = createGitLabOAuthAuthorizationUrl({
    baseUrl,
    clientId,
    redirectUri,
  });
  const response = NextResponse.redirect(url);
  response.cookies.set('roomote-gitlab-oauth-state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: publicAppUrl.startsWith('https://'),
    path: '/api/source-control/gitlab/oauth',
    maxAge: 600,
  });
  return response;
}
