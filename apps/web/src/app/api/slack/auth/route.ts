import { NextRequest, NextResponse } from 'next/server';

import { db, slackAuthTokens, users, eq, and, gt } from '@roomote/db/server';

import { authorize, getCallbackHost } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { createServerCaller } from '@/trpc/server';

export const runtime = 'nodejs';

async function buildPostAuthRedirectUrl({
  callbackHost,
  userId,
}: {
  callbackHost: string;
  userId: string;
}) {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        onboardingCompletedAt: true,
      },
    });

    if (user?.onboardingCompletedAt) {
      return new URL('/', callbackHost);
    }
  } catch (error) {
    console.error(
      `[slackAuth] Failed to determine onboarding redirect: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  return new URL('/onboarding', callbackHost);
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get('state');
  const callbackHost = getCallbackHost(request);

  if (!state) {
    return NextResponse.redirect(
      new URL('/error?message=Missing state parameter', callbackHost),
    );
  }

  await bootstrapWebRuntimeEnv();

  const [authToken] = await db
    .select()
    .from(slackAuthTokens)
    .where(
      and(
        eq(slackAuthTokens.token, state),
        gt(slackAuthTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!authToken) {
    return NextResponse.redirect(
      new URL('/error?message=Invalid or expired auth token', callbackHost),
    );
  }

  const authResult = await authorize();

  if (!authResult.success) {
    const returnPath = `/api/slack/auth?state=${encodeURIComponent(state)}`;
    const signInUrl = new URL('/sign-in', callbackHost);
    signInUrl.searchParams.set('redirect_url', returnPath);
    return NextResponse.redirect(signInUrl);
  }

  const { userId } = authResult;
  try {
    const caller = await createServerCaller();

    const result = await caller.slack.completePendingAuth({
      stateToken: state,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    try {
      await db.delete(slackAuthTokens).where(eq(slackAuthTokens.token, state));
    } catch (error) {
      console.error(
        `Failed to delete auth token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    const postAuthRedirectUrl = await buildPostAuthRedirectUrl({
      callbackHost,
      userId,
    });

    return NextResponse.redirect(postAuthRedirectUrl);
  } catch (error) {
    console.error(
      `Slack auth error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );

    try {
      await db.delete(slackAuthTokens).where(eq(slackAuthTokens.token, state));
    } catch (error) {
      console.error(
        `Failed to delete auth token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    return NextResponse.redirect(
      new URL('/error?message=Failed to complete authentication', callbackHost),
    );
  }
}
