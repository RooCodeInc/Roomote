import { NextRequest, NextResponse } from 'next/server';

import { db, mcpConnections } from '@roomote/db/server';
import {
  getDefaultMcpConnectionRole,
  getMcpIntegration,
  getMcpIntegrationConnectionScope,
} from '@roomote/types';
import { getMcpOauthReplay, updateMcpOauthReplay } from '@roomote/sdk/server';

import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

function buildReplayReturnPath(token: string) {
  return `/api/mcp-oauth/replay/${encodeURIComponent(token)}`;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const webUrl = getPublicAppUrl(webEnv);
  const { token } = await params;
  const replay = await getMcpOauthReplay(token);

  if (!replay) {
    return NextResponse.redirect(
      new URL('/error?message=Invalid or expired auth token', webUrl),
    );
  }

  const authResult = await authorize();
  if (!authResult.success) {
    const signInUrl = new URL('/sign-in', webUrl);
    signInUrl.searchParams.set('redirect_url', buildReplayReturnPath(token));
    return NextResponse.redirect(signInUrl);
  }

  const integration = getMcpIntegration(replay.mcpId);
  if (!integration) {
    return NextResponse.redirect(
      new URL('/error?message=Unknown MCP integration', webUrl),
    );
  }

  const connectionRole =
    replay.connectionRole ?? getDefaultMcpConnectionRole(integration);
  const connectionScope = getMcpIntegrationConnectionScope(
    integration,
    connectionRole,
  );

  const targetUserId =
    connectionScope === 'deployment' ? null : authResult.userId;

  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId: targetUserId,
      mcpId: replay.mcpId,
      connectionRole,
      authConfig: null,
      enabled: false,
      authStatus: 'pending',
    })
    .onConflictDoUpdate({
      target: [
        mcpConnections.userId,
        mcpConnections.mcpId,
        mcpConnections.connectionRole,
      ],
      set: {
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!connection) {
    return NextResponse.redirect(
      new URL('/error?message=Failed to prepare linked account flow', webUrl),
    );
  }

  await updateMcpOauthReplay(token, {
    connectionId: connection.id,
    userId: authResult.userId,
  });

  const redirectTo =
    replay.redirectTo && replay.redirectTo.startsWith('/')
      ? replay.redirectTo
      : '/settings/personal';

  return NextResponse.redirect(
    new URL(
      `/api/mcp-oauth/initiate/${connection.id}?redirectTo=${encodeURIComponent(
        redirectTo,
      )}&replayToken=${encodeURIComponent(token)}`,
      webUrl,
    ),
  );
}
