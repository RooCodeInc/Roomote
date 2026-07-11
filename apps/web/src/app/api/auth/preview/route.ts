import { NextRequest, NextResponse } from 'next/server';

import { createPreviewToken } from '@roomote/auth';
import {
  db,
  eq,
  resolveEffectivePreviewRuntimeConfig,
  tasks,
} from '@roomote/db/server';

import { Env, getSignedInAuthContext } from '@/lib/server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    // CRITICAL: Require PREVIEW_DOMAINS to be configured - fail closed for security
    // Supports comma-separated list: "roomote-preview.dev,preview-john.ngrok.app,127.0.0.1.sslip.io"
    const resolvedPreviewRuntimeConfig =
      await resolveEffectivePreviewRuntimeConfig({
        runtimeEnv: process.env,
        defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
        defaultPreviewDomains: Env.PREVIEW_DOMAINS,
      });
    const previewDomainsRaw =
      resolvedPreviewRuntimeConfig.effective.previewDomains;

    if (!previewDomainsRaw) {
      console.error('PREVIEW_DOMAINS environment variable is not configured');

      return NextResponse.json(
        { error: 'Service misconfigured' },
        { status: 500 },
      );
    }

    // Parse comma-separated domains and strip ports (hostname never includes port)
    const previewDomains = previewDomainsRaw
      .split(',')
      .map((d) => d.trim().split(':')[0])
      .filter(Boolean);

    const searchParams = request.nextUrl.searchParams;
    const taskId = searchParams.get('task_id');
    const state = searchParams.get('state');
    const redirectUri = searchParams.get('redirect_uri');

    // Validate required parameters
    if (!taskId || !state || !redirectUri) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 },
      );
    }

    // Validate redirect_uri is to one of the valid preview domains
    try {
      const redirectUrl = new URL(redirectUri);

      // Check if hostname matches exactly (e.g., "localhost") or is a
      // subdomain (e.g., "x.roomote-preview.dev")
      const isValidDomain = previewDomains.some(
        (domain) =>
          redirectUrl.hostname === domain ||
          redirectUrl.hostname.endsWith(`.${domain}`),
      );

      if (!isValidDomain) {
        return NextResponse.json(
          { error: 'Invalid redirect URI' },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'Invalid redirect URI format' },
        { status: 400 },
      );
    }

    const authResult = await getSignedInAuthContext();

    if (!authResult.success) {
      // Redirect to sign-in with return URL.
      // IMPORTANT: In local dev behind ngrok, Next may construct `request.url` using
      // `localhost:3000` as the host. Use R_APP_URL as the canonical host
      // for redirects so auth happens on the public ngrok URL.
      const appBaseUrl = new URL(Env.R_APP_URL);

      const returnUrl = new URL(request.url);
      returnUrl.protocol = appBaseUrl.protocol;
      returnUrl.hostname = appBaseUrl.hostname;
      returnUrl.port = appBaseUrl.port;

      const signInUrl = new URL('/sign-in', appBaseUrl.origin);
      signInUrl.searchParams.set('redirect_url', returnUrl.toString());
      return NextResponse.redirect(signInUrl);
    }

    const userId = authResult.userId;

    // CRITICAL: Verify user has access to the task.
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found or access denied' },
        { status: 404 },
      );
    }

    // Generate the preview auth token.
    const token = await createPreviewToken({
      userId,
      timeoutSeconds: Env.PREVIEW_TOKEN_TTL_SECONDS,
    });

    // Create the callback URL with the token.
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('state', state);
    callbackUrl.searchParams.set('token', token);

    return NextResponse.redirect(callbackUrl);
  } catch (error) {
    console.error('Preview auth error:', error);

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
