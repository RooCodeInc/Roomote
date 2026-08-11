import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getRoomoteMcpResourceUrl, ROOMOTE_MCP_SCOPE } from '@roomote/auth';

import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import {
  createRemoteMcpAuthorizationCode,
  getRemoteMcpOAuthClient,
} from '@/lib/server/mcp-remote-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const authorizeSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().uuid(),
  redirect_uri: z.string().url(),
  state: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
  resource: z.string().url(),
  scope: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const env = await bootstrapWebRuntimeEnv();
  const webUrl = getPublicAppUrl(env);
  const parsed = authorizeSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const input = parsed.data;
  const client = await getRemoteMcpOAuthClient(input.client_id);
  if (!client || !client.redirectUris.includes(input.redirect_uri)) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const expectedResource = getRoomoteMcpResourceUrl(env.TRPC_URL);
  const scopes = (input.scope ?? ROOMOTE_MCP_SCOPE)
    .split(/\s+/)
    .filter(Boolean);
  if (
    input.resource !== expectedResource ||
    scopes.length !== 1 ||
    scopes[0] !== ROOMOTE_MCP_SCOPE
  ) {
    const redirect = new URL(input.redirect_uri);
    redirect.searchParams.set('error', 'invalid_scope');
    redirect.searchParams.set('state', input.state);
    return NextResponse.redirect(redirect);
  }

  const auth = await authorize();
  if (!auth.success) {
    const signInUrl = new URL('/sign-in', webUrl);
    signInUrl.searchParams.set(
      'redirect_url',
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(signInUrl);
  }

  const code = await createRemoteMcpAuthorizationCode({
    userId: auth.userId,
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    codeChallenge: input.code_challenge,
    resource: input.resource,
    scopes,
  });
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', input.state);
  return NextResponse.redirect(redirect);
}
