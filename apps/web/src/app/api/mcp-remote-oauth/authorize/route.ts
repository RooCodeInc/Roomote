import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getRoomoteMcpResourceUrl, ROOMOTE_MCP_SCOPE } from '@roomote/auth';

import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import {
  createRemoteMcpAuthorizationCode,
  createRemoteMcpConsentToken,
  consumeRemoteMcpConsentToken,
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
  resource: z.string().url().optional(),
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
  consentToken: string;
  redirectUri: string;
}) {
  const action = escapeHtml(
    `${options.request.nextUrl.pathname}${options.request.nextUrl.search}`,
  );
  const clientName = escapeHtml(options.clientName ?? 'An MCP client');
  const callbackUrl = new URL(options.redirectUri);
  const callbackHost = escapeHtml(callbackUrl.host);
  const consentToken = escapeHtml(options.consentToken);

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize ${clientName}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "DM Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #000;
        background: #fff;
      }

      * { box-sizing: border-box; }

      body { margin: 0; min-width: 320px; }

      .frame {
        min-height: 100vh;
        padding: 8px;
        background: #fff;
      }

      .surface {
        min-height: calc(100vh - 16px);
        display: flex;
        overflow: hidden;
        border-radius: 24px;
        background: #d9f52b;
        background: oklch(0.9 0.18 120);
      }

      .column {
        position: relative;
        width: 100%;
        max-width: 768px;
        min-height: calc(100vh - 16px);
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 40px 24px 48px 48px;
      }

      .column::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        border-left: 2px dotted #000;
      }

      .wordmark {
        width: auto;
        height: 56px;
        align-self: flex-start;
        margin: 0 0 32px;
      }

      .content { width: 100%; max-width: 640px; }

      .eyebrow {
        margin: 0 0 8px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(30px, 5vw, 40px);
        line-height: 1.05;
        letter-spacing: -0.05em;
      }

      .description {
        max-width: 580px;
        margin: 16px 0 0;
        font-size: 17px;
        line-height: 1.55;
      }

      .permissions {
        max-width: 580px;
        margin: 24px 0;
        padding: 18px 20px;
        border: 1px solid rgba(0, 0, 0, 0.35);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.35);
      }

      .permissions p {
        margin: 0 0 10px;
        font-size: 14px;
        font-weight: 700;
      }

      .permissions ul {
        margin: 0;
        padding-left: 20px;
        font-size: 14px;
        line-height: 1.65;
      }

      .return-to {
        max-width: 580px;
        margin: 0 0 24px;
        font-size: 14px;
        line-height: 1.5;
      }

      .return-to strong {
        overflow-wrap: anywhere;
        font-weight: 700;
      }

      form { max-width: 384px; }

      button {
        width: 100%;
        height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 16px;
        border: 0;
        border-radius: 8px;
        background: #000;
        color: #fff;
        font: inherit;
        font-size: 17px;
        font-weight: 700;
        cursor: pointer;
        transition: background-color 150ms ease, color 150ms ease, opacity 150ms ease;
      }

      button:hover { background: rgba(0, 0, 0, 0.8); color: #d9f52b; }
      button:active { opacity: 0.8; }
      button:focus-visible { outline: 2px solid #000; outline-offset: 3px; }

      .trust-note {
        max-width: 384px;
        margin: 10px 0 0;
        color: rgba(0, 0, 0, 0.65);
        font-size: 12px;
        line-height: 1.45;
      }

      @media (max-width: 767px) {
        .column {
          min-height: auto;
          justify-content: flex-start;
          padding: 32px 16px 40px;
        }

        .column::before { display: none; }
        .wordmark { height: 48px; margin-bottom: 40px; }
      }

      @media (prefers-reduced-motion: reduce) {
        button { transition: none; }
      }
    </style>
  </head>
  <body>
    <div class="frame">
      <main class="surface">
        <div class="column">
          <img class="wordmark" src="/logos/roomote-wordmark.svg" alt="Roomote">
          <section class="content" aria-labelledby="consent-title">
            <p class="eyebrow">MCP access request</p>
            <h1 id="consent-title">Authorize ${clientName}?</h1>
            <p class="description">This gives ${clientName} access to Roomote using your account.</p>
            <div class="permissions">
              <p>${clientName} will be able to:</p>
              <ul>
                <li>Read your task and chat context</li>
                <li>Launch and cancel tasks</li>
                <li>Send follow-up messages</li>
              </ul>
            </div>
            <p class="return-to">After approval, you’ll return to <strong>${callbackHost}</strong>.</p>
            <form method="post" action="${action}">
              <input type="hidden" name="consent_token" value="${consentToken}">
              <button type="submit"><span>Allow access</span><span aria-hidden="true">&rarr;</span></button>
            </form>
            <p class="trust-note">Only continue if you trust this application.</p>
          </section>
        </div>
      </main>
    </div>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' ${callbackUrl.origin}; base-uri 'none'; frame-ancestors 'none'`,
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

  const expectedResource = getRoomoteMcpResourceUrl(
    env.R_PUBLIC_URL ?? env.R_APP_URL,
  );
  const resource = input.resource ?? expectedResource;
  const scopes = (input.scope ?? ROOMOTE_MCP_SCOPE)
    .split(/\s+/)
    .filter(Boolean);
  if (
    resource !== expectedResource ||
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

  const consentBinding = {
    userId: auth.userId,
    requestTarget: `${request.nextUrl.pathname}${request.nextUrl.search}`,
  };

  if (!approved) {
    const consentToken = await createRemoteMcpConsentToken(consentBinding);
    return consentResponse({
      request,
      clientName: client.clientName,
      consentToken,
      redirectUri: input.redirect_uri,
    });
  }

  let consentToken: FormDataEntryValue | null;
  try {
    consentToken = (await request.formData()).get('consent_token');
  } catch {
    consentToken = null;
  }
  if (
    typeof consentToken !== 'string' ||
    !(await consumeRemoteMcpConsentToken(consentToken, consentBinding))
  ) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const code = await createRemoteMcpAuthorizationCode({
    userId: auth.userId,
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    codeChallenge: input.code_challenge,
    resource,
    scopes,
  });
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', input.state);
  return NextResponse.redirect(redirect, 303);
}

export function GET(request: NextRequest) {
  return handleAuthorize(request, false);
}

export function POST(request: NextRequest) {
  return handleAuthorize(request, true);
}
