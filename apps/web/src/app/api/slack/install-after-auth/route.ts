import { NextRequest, NextResponse } from 'next/server';

import { getCallbackHost } from '@/lib/server';
import { createServerCaller } from '@/trpc/server';

export const runtime = 'nodejs';

function getSafeRedirectPath(rawRedirectPath: string | null): string {
  if (!rawRedirectPath) {
    return '/';
  }

  if (!rawRedirectPath.startsWith('/') || rawRedirectPath.startsWith('//')) {
    return '/';
  }

  return rawRedirectPath;
}

function buildRedirectUrl({
  callbackHost,
  redirectPath,
  error,
}: {
  callbackHost: string;
  redirectPath: string;
  error?: string;
}) {
  const redirectUrl = new URL(redirectPath, callbackHost);

  if (error) {
    redirectUrl.searchParams.set('error', error);
  }

  return redirectUrl;
}

export async function GET(request: NextRequest) {
  const callbackHost = getCallbackHost(request);
  const redirectPath = getSafeRedirectPath(
    request.nextUrl.searchParams.get('redirect'),
  );

  try {
    const caller = await createServerCaller();
    const installation = await caller.slack.installation();

    if (installation) {
      return NextResponse.redirect(
        buildRedirectUrl({ callbackHost, redirectPath }),
      );
    }

    const result = await caller.slack.connectApp({ redirectPath });

    if (!result.success) {
      return NextResponse.redirect(
        buildRedirectUrl({
          callbackHost,
          redirectPath,
          error: result.error,
        }),
      );
    }

    return NextResponse.redirect(result.url);
  } catch (error) {
    console.error(
      '[slackInstallAfterAuth] Failed to continue Slack setup:',
      error,
    );

    const signInUrl = new URL('/sign-in', callbackHost);
    signInUrl.searchParams.set('redirect_url', redirectPath);
    return NextResponse.redirect(signInUrl);
  }
}
