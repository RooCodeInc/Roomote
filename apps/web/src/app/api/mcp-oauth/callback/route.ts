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
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import { logger } from '@/lib/server/logger';
import { hydrateLinearMcpConnectionAfterOauth } from '@/lib/server/mcp-linear';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const DEFAULT_REDIRECT_PATH = '/settings';
const REDIRECT_STATE_DELIMITER = '~';

type McpOAuthCallbackStage =
  | 'state_validation'
  | 'connection_lookup'
  | 'client_lookup'
  | 'provider_discovery'
  | 'token_exchange'
  | 'token_storage'
  | 'linear_metadata'
  | 'deployment_enablement';

function getCallbackFailureReason(stage: McpOAuthCallbackStage): string {
  switch (stage) {
    case 'provider_discovery':
      return 'provider_metadata_failed';
    case 'token_exchange':
      return 'token_exchange_failed';
    case 'token_storage':
      return 'token_storage_failed';
    case 'linear_metadata':
      return 'linear_metadata_failed';
    case 'deployment_enablement':
      return 'deployment_enablement_failed';
    default:
      return 'callback_failed';
  }
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

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

  const webUrl = getPublicAppUrl(webEnv);
  const redirectPath = readRedirectPathFromState(state);

  // Handle OAuth errors
  if (error) {
    const reason =
      error === 'access_denied' ? 'access_denied' : 'provider_error';
    logger.warn(
      {
        event: 'mcp_oauth_provider_error',
        providerError: reason,
        hasErrorDescription: Boolean(errorDescription),
      },
      'MCP OAuth provider returned an error',
    );

    if (state) {
      try {
        const oauthState = await consumeOAuthState(state);
        if (oauthState) {
          await updateAuthStatus(oauthState.connectionId, 'error');
          return NextResponse.redirect(
            withMcpQuery(webUrl, redirectPath, 'error', reason),
          );
        }
      } catch (e) {
        logger.error(
          {
            event: 'mcp_oauth_provider_error_state_update_failed',
            errorName: getErrorName(e),
          },
          'Failed to mark an MCP OAuth provider error',
        );
      }
    }

    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', reason),
    );
  }

  // Validate required parameters
  if (!code || !state) {
    logger.warn(
      {
        event: 'mcp_oauth_callback_rejected',
        reason: 'missing_params',
        hasCode: Boolean(code),
        hasState: Boolean(state),
      },
      'MCP OAuth callback was rejected',
    );
    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', 'missing_params'),
    );
  }

  const authResult = await authorize();
  if (!authResult.success) {
    const configuredCallbackHost = new URL(webUrl).host;
    logger.warn(
      {
        event: 'mcp_oauth_callback_rejected',
        reason: 'unauthorized',
        requestHost: request.nextUrl.host,
        configuredCallbackHost,
        callbackHostMatchesRequest:
          request.nextUrl.host === configuredCallbackHost,
      },
      'MCP OAuth callback was rejected',
    );
    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', 'unauthorized'),
    );
  }
  const { userId } = authResult;

  let connectionId: string | undefined;
  let integrationId: string | undefined;
  let connectionRole: string | undefined;
  let failureStage: McpOAuthCallbackStage = 'state_validation';

  try {
    const oauthState = await consumeOAuthState(state);
    if (!oauthState) {
      logger.warn(
        {
          event: 'mcp_oauth_callback_rejected',
          reason: 'invalid_state',
        },
        'MCP OAuth callback was rejected',
      );
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'invalid_state'),
      );
    }

    const resolvedConnectionId = oauthState.connectionId;
    connectionId = resolvedConnectionId;

    failureStage = 'connection_lookup';
    const connection = await db.query.mcpConnections.findFirst({
      where: eq(mcpConnections.id, resolvedConnectionId),
    });
    if (!connection) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_found'),
      );
    }
    integrationId = connection.mcpId;
    connectionRole = connection.connectionRole;

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

    failureStage = 'client_lookup';
    const clientInfo = await getClientInformation(resolvedConnectionId);
    if (!clientInfo) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'not_registered'),
      );
    }

    failureStage = 'provider_discovery';
    const serverMetadata = await discoverOAuthEndpoints(integration.url);
    const redirectUri = new URL('/api/mcp-oauth/callback', webUrl).toString();

    failureStage = 'token_exchange';
    const tokens = await exchangeCodeForTokens(
      serverMetadata.token_endpoint,
      code,
      oauthState.codeVerifier,
      clientInfo,
      redirectUri,
    );

    failureStage = 'token_storage';
    await storeTokens(resolvedConnectionId, tokens);

    if (integration.id === 'linear') {
      failureStage = 'linear_metadata';
      await hydrateLinearMcpConnectionAfterOauth({
        connection,
        accessToken: tokens.access_token,
        replayToken: oauthState.replayToken,
        enabledByUserId: userId,
      });
    }

    if (requiresOrgAdmin) {
      failureStage = 'deployment_enablement';
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
    const reason = getCallbackFailureReason(failureStage);
    logger.error(
      {
        event: 'mcp_oauth_callback_failed',
        failureStage,
        reason,
        integrationId,
        connectionRole,
        connectionId,
        errorName: getErrorName(error),
      },
      'MCP OAuth callback failed',
    );

    if (connectionId) {
      try {
        await updateAuthStatus(connectionId, 'error');
      } catch (statusError) {
        logger.error(
          {
            event: 'mcp_oauth_error_status_update_failed',
            connectionId,
            integrationId,
            errorName: getErrorName(statusError),
          },
          'Failed to mark an MCP OAuth connection as errored',
        );
      }
    }

    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', reason),
    );
  }
}
