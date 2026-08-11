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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

function consentResponse(options: {
  request: NextRequest;
  clientName?: string;
  redirectUri: string;
}) {
  const action = escapeHtml(
    `${options.request.nextUrl.pathname}${options.request.nextUrl.search}`,
  );
  const clientName = escapeHtml(options.clientName ?? 'An MCP client');
  const callbackHost = escapeHtml(new URL(options.redirectUri).host);

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize ${clientName}</title>
  </head>
  <body style="margin:0;background:#f6f5f1;color:#171713;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;">
      <section style="width:min(100%,520px);background:#fff;border:1px solid #deddd6;border-radius:18px;padding:32px;box-sizing:border-box;box-shadow:0 18px 50px rgba(23,23,19,.08);">
        <p style="margin:0 0 12px;color:#68675f;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Roomote MCP</p>
        <h1 style="margin:0 0 14px;font-size:28px;line-height:1.15;">Authorize ${clientName}?</h1>
        <p style="margin:0 0 22px;color:#55544e;font-size:16px;line-height:1.55;">This client will act as your signed-in Roomote member. It can read task and chat context, launch or cancel tasks, and send follow-up messages.</p>
        <div style="margin:0 0 24px;padding:14px 16px;background:#f6f5f1;border-radius:12px;color:#55544e;font-size:14px;line-height:1.45;">After approval, Roomote returns you to <strong style="color:#171713;">${callbackHost}</strong>.</div>
        <form method="post" action="${action}">
          <button type="submit" style="width:100%;border:0;border-radius:10px;background:#171713;color:#fff;padding:13px 18px;font:inherit;font-weight:700;cursor:pointer;">Allow access</button>
        </form>
      </section>
    </main>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
      },
    },
  );
}

async function handleAuthorize(request: NextRequest, approved: boolean) {
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

  if (!approved) {
    return consentResponse({
      request,
      clientName: client.clientName,
      redirectUri: input.redirect_uri,
    });
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

export function GET(request: NextRequest) {
  return handleAuthorize(request, false);
}

export function POST(request: NextRequest) {
  return handleAuthorize(request, true);
}
