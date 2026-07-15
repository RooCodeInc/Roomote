import { type NextRequest } from 'next/server';

import { GET as handleDeploymentOAuthCallback } from '@/app/api/source-control/bitbucket/oauth/callback/route';
import { handleAuthRequest } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get('state');
  const deploymentState = request.cookies.get(
    'roomote-bitbucket-oauth-state',
  )?.value;

  if (state && deploymentState && state === deploymentState) {
    return handleDeploymentOAuthCallback(request);
  }

  return handleAuthRequest(request);
}
