import { NextRequest, NextResponse } from 'next/server';

import { decodeSlackOAuthState, getCallbackHost } from '@/lib/server';
import { createServerCaller } from '@/trpc/server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const callbackHost = getCallbackHost(request);
  const decodedState = await decodeSlackOAuthState(state);

  const redirectPath = decodedState?.redirectPath ?? '/settings';

  if (error) {
    const redirectUrl = new URL(redirectPath, callbackHost);
    redirectUrl.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(redirectUrl);
  }

  if (!code || !state || !decodedState) {
    const redirectUrl = new URL(redirectPath, callbackHost);
    redirectUrl.searchParams.set('error', 'invalid_callback');
    return NextResponse.redirect(redirectUrl);
  }

  try {
    const caller = await createServerCaller();

    // User-level profile linking (OIDC flow)
    if (decodedState.mode === 'link_account') {
      const result = await caller.slack.finishAuthenticateAccount({ code });
      const redirectUrl = new URL(redirectPath, callbackHost);

      if (result.success) {
        redirectUrl.searchParams.set('slack', 'connected');
      } else {
        redirectUrl.searchParams.set('error', result.error);
      }

      return NextResponse.redirect(redirectUrl);
    }

    // Deployment-level Slack app installation (admin-only)
    const result = await caller.slack.exchangeOAuthCode({ code, state });
    const redirectUrl = new URL(redirectPath, callbackHost);

    if (result.success) {
      redirectUrl.searchParams.set('slack', 'connected');
    } else {
      redirectUrl.searchParams.set('error', 'failed_to_exchange_code');
    }

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    console.error('Slack OAuth callback error:', error);

    const redirectUrl = new URL(redirectPath, callbackHost);
    redirectUrl.searchParams.set('error', 'unknown_error');
    return NextResponse.redirect(redirectUrl);
  }
}
