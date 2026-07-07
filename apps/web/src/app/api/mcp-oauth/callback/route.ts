import { type NextRequest, NextResponse } from 'next/server';

import {
  db,
  mcpConnections,
  deploymentMcpEnablements,
  eq,
} from '@roomote/db/server';
import {
  getMcpIntegration,
  isDeploymentScopedMcpIntegration,
  isSelfServeMcpIntegration,
} from '@roomote/types';
import {
  discoverOAuthEndpoints,
  exchangeCodeForTokens,
  consumeOAuthState,
  storeTokens,
  getClientInformation,
  updateAuthStatus,
} from '@roomote/sdk/server';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { hydrateLinearMcpConnectionAfterOauth } from '@/lib/server/mcp-linear';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const DEFAULT_REDIRECT_PATH = '/settings';
const REDIRECT_STATE_DELIMITER = '~';

function sanitizeRedirectPath(redirectTo: string | null): string | null {
  if (!redirectTo) {
    return null;
  }

  if (!redirectTo.startsWith('/') || redirectTo.startsWith('//')) {
    return null;
  }

  return redirectTo;
}

function readRedirectPathFromState(state: string | null): string {
  if (!state) {
    return DEFAULT_REDIRECT_PATH;
  }

  const delimiterIndex = state.lastIndexOf(REDIRECT_STATE_DELIMITER);
  if (delimiterIndex === -1 || delimiterIndex === state.length - 1) {
    return DEFAULT_REDIRECT_PATH;
  }

  const encodedPath = state.slice(delimiterIndex + 1);
  try {
    const decodedPath = Buffer.from(encodedPath, 'base64url').toString('utf8');
    return sanitizeRedirectPath(decodedPath) ?? DEFAULT_REDIRECT_PATH;
  } catch {
    return DEFAULT_REDIRECT_PATH;
  }
}

function withMcpQuery(
  webUrl: string,
  redirectPath: string,
  mcpStatus: 'error' | 'connected',
  reason?: string,
) {
  const url = new URL(redirectPath, webUrl);
  url.searchParams.set('mcp', mcpStatus);
  if (reason) {
    url.searchParams.set('reason', reason);
  }
  return url;
}

export async function GET(request: NextRequest) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');
  const errorDescription =
    request.nextUrl.searchParams.get('error_description');

  const webUrl = webEnv.ROOMOTE_APP_URL;
  const redirectPath = readRedirectPathFromState(state);

  // Handle OAuth errors
  if (error) {
    console.error('[MCP OAuth] OAuth error:', error, errorDescription);

    if (state) {
      try {
        const oauthState = await consumeOAuthState(state);
        if (oauthState) {
          await updateAuthStatus(oauthState.connectionId, 'error');
          return NextResponse.redirect(
            withMcpQuery(webUrl, redirectPath, 'error'),
          );
        }
      } catch (e) {
        console.error(
          '[MCP OAuth] Error consuming state during error handling:',
          e,
        );
      }
    }

    return NextResponse.redirect(withMcpQuery(webUrl, redirectPath, 'error'));
  }

  // Validate required parameters
  if (!code || !state) {
    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', 'missing_params'),
    );
  }

  const authResult = await authorize();
  if (!authResult.success) {
    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', 'unauthorized'),
    );
  }
  const { userId } = authResult;

  let connectionId: string | undefined;

  try {
    const oauthState = await consumeOAuthState(state);
    if (!oauthState) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'invalid_state'),
      );
    }

    const resolvedConnectionId = oauthState.connectionId;
    connectionId = resolvedConnectionId;

    const connection = await db.query.mcpConnections.findFirst({
      where: eq(mcpConnections.id, resolvedConnectionId),
    });
    if (!connection) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_found'),
      );
    }

    const integration = getMcpIntegration(connection.mcpId);
    if (!integration) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_found'),
      );
    }

    if (!isSelfServeMcpIntegration(integration) || !integration.url) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_found'),
      );
    }

    const requiresOrgAdmin = isDeploymentScopedMcpIntegration(
      integration,
      connection.connectionRole,
    );
    const isAdmin = authResult.isAdmin;

    if (
      (requiresOrgAdmin && !isAdmin) ||
      (!requiresOrgAdmin && connection.userId !== userId)
    ) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_found'),
      );
    }

    const clientInfo = await getClientInformation(resolvedConnectionId);
    if (!clientInfo) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_registered'),
      );
    }

    const serverMetadata = await discoverOAuthEndpoints(integration.url);
    const redirectUri = `${webEnv.ROOMOTE_APP_URL}/api/mcp-oauth/callback`;

    const tokens = await exchangeCodeForTokens(
      serverMetadata.token_endpoint,
      code,
      oauthState.codeVerifier,
      clientInfo,
      redirectUri,
    );

    await storeTokens(resolvedConnectionId, tokens);

    if (integration.id === 'linear') {
      await hydrateLinearMcpConnectionAfterOauth({
        connection,
        accessToken: tokens.access_token,
        replayToken: oauthState.replayToken,
        enabledByUserId: userId,
      });
    }

    if (requiresOrgAdmin) {
      await db
        .insert(deploymentMcpEnablements)
        .values({
          mcpId: integration.id,
          enabled: true,
          enabledByUserId: userId,
        })
        .onConflictDoUpdate({
          target: deploymentMcpEnablements.mcpId,
          set: {
            enabled: true,
            enabledByUserId: userId,
            updatedAt: new Date(),
          },
        });
    }

    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'connected'),
    );
  } catch (error) {
    console.error('[MCP OAuth] Error in callback:', error);

    if (connectionId) {
      try {
        await updateAuthStatus(connectionId, 'error');
        return NextResponse.redirect(
          withMcpQuery(webUrl, redirectPath, 'error'),
        );
      } catch {
        // Ignore errors during error handling
      }
    }

    return NextResponse.redirect(withMcpQuery(webUrl, redirectPath, 'error'));
  }
}
