import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createMcpAccessToken,
  DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS,
  ROOMOTE_MCP_SCOPE,
} from '@roomote/auth';

import {
  consumeRemoteMcpAuthorizationCode,
  createRemoteMcpRefreshSession,
  getRemoteMcpAuthorizationCode,
  getRemoteMcpOAuthClient,
  getRemoteMcpRefreshSession,
  promoteRemoteMcpOAuthClient,
  rotateRemoteMcpRefreshToken,
  verifyPkceChallenge,
} from '@/lib/server/mcp-remote-oauth';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';

const tokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    client_id: z.string().uuid(),
    redirect_uri: z.string().url(),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    resource: z.string().url(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().uuid(),
    resource: z.string().url(),
    scope: z.string().optional(),
  }),
]);

function oauthError(error: string) {
  return NextResponse.json(
    { error },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
}

function tokenResponse(accessToken: string, refreshToken?: string) {
  return NextResponse.json(
    {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      token_type: 'Bearer',
      expires_in: DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS / 1000,
      scope: ROOMOTE_MCP_SCOPE,
    },
    { headers: { 'Cache-Control': 'no-store' } },
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
  await bootstrapWebRuntimeEnv();

  if (input.grant_type === 'refresh_token') {
    const [session, client] = await Promise.all([
      getRemoteMcpRefreshSession(input.refresh_token),
      getRemoteMcpOAuthClient(input.client_id),
    ]);
    if (
      !session ||
      !client ||
      !client.grantTypes.includes('refresh_token') ||
      session.clientId !== input.client_id ||
      session.resource !== input.resource ||
      session.scopes.length !== 1 ||
      session.scopes[0] !== ROOMOTE_MCP_SCOPE ||
      (input.scope !== undefined && input.scope !== ROOMOTE_MCP_SCOPE)
    ) {
      return oauthError('invalid_grant');
    }

    const accessToken = await createMcpAccessToken({
      userId: session.userId,
      resource: session.resource,
      scopes: [ROOMOTE_MCP_SCOPE],
      timeoutMs: DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS,
    });
    const rotation = await rotateRemoteMcpRefreshToken(
      input.refresh_token,
      session,
    );
    if (rotation.status !== 'ok') return oauthError('invalid_grant');
    return tokenResponse(accessToken, rotation.refreshToken);
  }

  const authorization = await getRemoteMcpAuthorizationCode(input.code);
  const client = authorization
    ? await getRemoteMcpOAuthClient(authorization.clientId)
    : null;
  if (
    !authorization ||
    !client ||
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
  const refreshToken = client.grantTypes.includes('refresh_token')
    ? await createRemoteMcpRefreshSession({
        userId: authorization.userId,
        clientId: authorization.clientId,
        resource: authorization.resource,
        scopes: [ROOMOTE_MCP_SCOPE],
      })
    : undefined;

  return tokenResponse(accessToken, refreshToken);
}
