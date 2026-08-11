import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createMcpAccessToken,
  DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS,
  ROOMOTE_MCP_SCOPE,
} from '@roomote/auth';

import {
  consumeRemoteMcpAuthorizationCode,
  getRemoteMcpAuthorizationCode,
  promoteRemoteMcpOAuthClient,
  verifyPkceChallenge,
} from '@/lib/server/mcp-remote-oauth';

export const runtime = 'nodejs';

const tokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  client_id: z.string().uuid(),
  redirect_uri: z.string().url(),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  resource: z.string().url(),
});

function oauthError(error: string) {
  return NextResponse.json(
    { error },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError('invalid_request');
  }

  const parsed = tokenSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return oauthError('invalid_request');
  }

  const input = parsed.data;
  const authorization = await getRemoteMcpAuthorizationCode(input.code);
  if (
    !authorization ||
    authorization.clientId !== input.client_id ||
    authorization.redirectUri !== input.redirect_uri ||
    input.resource !== authorization.resource ||
    authorization.scopes.length !== 1 ||
    authorization.scopes[0] !== ROOMOTE_MCP_SCOPE ||
    !verifyPkceChallenge(input.code_verifier, authorization.codeChallenge)
  ) {
    return oauthError('invalid_grant');
  }

  if (
    !(await promoteRemoteMcpOAuthClient(
      authorization.clientId,
      authorization.userId,
    ))
  ) {
    return oauthError('invalid_grant');
  }

  if (!(await consumeRemoteMcpAuthorizationCode(input.code, authorization))) {
    return oauthError('invalid_grant');
  }

  const accessToken = await createMcpAccessToken({
    userId: authorization.userId,
    resource: authorization.resource,
    scopes: [ROOMOTE_MCP_SCOPE],
    timeoutMs: DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS,
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS / 1000,
      scope: ROOMOTE_MCP_SCOPE,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
