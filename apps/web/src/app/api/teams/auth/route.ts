import { NextRequest, NextResponse } from 'next/server';

import { authorize, getCallbackHost } from '@/lib/server';
import { handleAuthRequest } from '@/lib/server/auth';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';

type TeamsResumeResponse =
  | {
      success: true;
      status: 'queued' | 'resumed' | 'started' | 'replied_inline';
      taskUrl?: string;
    }
  | {
      success: false;
      error:
        | 'account_link_required'
        | 'invalid_or_expired_auth_token'
        | 'unsupported_activity'
        | string;
    };

function buildTeamsAuthReturnPath(stateToken: string, linked = false): string {
  const returnUrl = new URL('http://roomote.local/api/teams/auth');
  returnUrl.searchParams.set('state', stateToken);

  if (linked) {
    returnUrl.searchParams.set('linked', '1');
  }

  return `${returnUrl.pathname}${returnUrl.search}`;
}

function buildErrorRedirectUrl({
  callbackHost,
  message,
}: {
  callbackHost: string;
  message: string;
}): URL {
  const url = new URL('/error', callbackHost);
  url.searchParams.set('message', message);

  return url;
}

function resolveApiUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.replace(/^\/+/, '');

  return new URL(normalizedPath, normalizedBaseUrl);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const headerAccessor = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookieHeaders = headerAccessor.getSetCookie?.();

  if (setCookieHeaders?.length) {
    return setCookieHeaders;
  }

  const singleHeader = headers.get('set-cookie');

  return singleHeader ? [singleHeader] : [];
}

async function startMicrosoftOAuth({
  callbackHost,
  linkedReturn,
  request,
  stateToken,
  type,
}: {
  callbackHost: string;
  linkedReturn?: boolean;
  request: NextRequest;
  stateToken: string;
  type: 'link' | 'sign-in';
}): Promise<NextResponse> {
  const returnPath = buildTeamsAuthReturnPath(stateToken, linkedReturn);
  const headers = new Headers({ 'content-type': 'application/json' });
  const cookie = request.headers.get('cookie');

  if (cookie) {
    headers.set('cookie', cookie);
  }

  // Better Auth rejects state-changing requests without an Origin header
  // (MISSING_OR_NULL_ORIGIN), so this server-side call must carry one.
  headers.set('origin', new URL(callbackHost).origin);

  const authResponse = await handleAuthRequest(
    new Request(
      new URL(
        type === 'link' ? '/api/auth/oauth2/link' : '/api/auth/sign-in/oauth2',
        callbackHost,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerId: MICROSOFT_ENTRA_PROVIDER_ID,
          callbackURL: returnPath,
          errorCallbackURL: returnPath,
        }),
      },
    ),
  );

  const responseBody = (await authResponse.json().catch(() => null)) as {
    url?: string;
  } | null;

  if (!authResponse.ok || !responseBody?.url) {
    console.error(
      `[teamsAuth] Failed to start Microsoft ${type} flow: ${authResponse.status} body=${JSON.stringify(responseBody)}`,
    );

    return NextResponse.redirect(
      buildErrorRedirectUrl({
        callbackHost,
        message: 'Failed to start Microsoft Teams authentication',
      }),
    );
  }

  const redirectResponse = NextResponse.redirect(responseBody.url);

  for (const setCookieHeader of getSetCookieHeaders(authResponse.headers)) {
    redirectResponse.headers.append('set-cookie', setCookieHeader);
  }

  return redirectResponse;
}

async function resumePendingTeamsRequest({
  stateToken,
  trpcUrl,
}: {
  stateToken: string;
  trpcUrl: string;
}): Promise<{ response: Response; body: TeamsResumeResponse | null }> {
  const response = await fetch(
    resolveApiUrl(trpcUrl, '/api/webhooks/teams/auth/resume'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: stateToken }),
    },
  );
  const body = (await response
    .json()
    .catch(() => null)) as TeamsResumeResponse | null;

  return { response, body };
}

export async function GET(request: NextRequest) {
  const callbackHost = getCallbackHost(request);
  const stateToken = request.nextUrl.searchParams.get('state')?.trim();
  const alreadyLinked =
    request.nextUrl.searchParams.get('linked')?.trim() === '1';

  if (!stateToken) {
    return NextResponse.redirect(
      buildErrorRedirectUrl({
        callbackHost,
        message: 'Missing Teams authentication token',
      }),
    );
  }

  const env = await bootstrapWebRuntimeEnv();
  const authResult = await authorize();

  if (!authResult.success) {
    return startMicrosoftOAuth({
      callbackHost,
      request,
      stateToken,
      type: 'sign-in',
    });
  }

  const resumeResult = await resumePendingTeamsRequest({
    stateToken,
    trpcUrl: env.R_TRPC_URL,
  });
  const resumeBody = resumeResult.body;

  if (resumeResult.response.ok && resumeBody?.success) {
    return NextResponse.redirect(new URL('/', callbackHost));
  }

  if (
    resumeResult.response.status === 409 &&
    resumeBody &&
    !resumeBody.success &&
    resumeBody.error === 'account_link_required'
  ) {
    if (alreadyLinked) {
      return NextResponse.redirect(
        buildErrorRedirectUrl({
          callbackHost,
          message: 'Unable to link this Microsoft Teams account',
        }),
      );
    }

    return startMicrosoftOAuth({
      callbackHost,
      linkedReturn: true,
      request,
      stateToken,
      type: 'link',
    });
  }

  const message =
    resumeBody &&
    !resumeBody.success &&
    resumeBody.error === 'invalid_or_expired_auth_token'
      ? 'Invalid or expired Teams authentication token'
      : 'Failed to continue the Microsoft Teams request';

  return NextResponse.redirect(
    buildErrorRedirectUrl({ callbackHost, message }),
  );
}
