import { NextResponse } from 'next/server';

import { ROOMOTE_MCP_SCOPE } from '@roomote/auth';

import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const env = await bootstrapWebRuntimeEnv();
  const issuer = new URL(getPublicAppUrl(env)).origin;

  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/api/mcp-remote-oauth/authorize`,
      token_endpoint: `${issuer}/api/mcp-remote-oauth/token`,
      registration_endpoint: `${issuer}/api/mcp-remote-oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [ROOMOTE_MCP_SCOPE],
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
