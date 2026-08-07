import { createHash } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';

import {
  db,
  mcpConnections,
  deploymentMcpEnablements,
  eq,
} from '@roomote/db/server';
import {
  getMcpIntegration,
  getMcpIntegrationDefaultDisabledTools,
  getMcpIntegrationOauthEndpoints,
  isCustomMcpConnectionId,
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
  resolveCustomMcpAuthTarget,
  ensureCustomMcpServerMetadata,
} from '@roomote/sdk/server';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import { logger } from '@/lib/server/logger';
import {
  hydrateLinearMcpConnectionAfterOauth,
  LinearReplayIdentityMismatchError,
} from '@/lib/server/mcp-linear';
import type {
  McpOAuthErrorReason,
  McpOAuthResult,
} from '@/lib/mcp-oauth-result';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const DEFAULT_REDIRECT_PATH = '/settings';
const REDIRECT_STATE_DELIMITER = '~';
const CALLBACK_PATH = '/api/mcp-oauth/callback';
const CONTINUATION_COOKIE_PREFIX = 'roomote-mcp-oauth-continuation-';
const CONTINUATION_MAX_AGE_SECONDS = 10 * 60;

type McpOAuthCallbackStage =
  | 'state_validation'
  | 'connection_lookup'
  | 'client_lookup'
  | 'provider_discovery'
  | 'token_exchange'
  | 'token_storage'
  | 'linear_metadata'
  | 'deployment_enablement';

function getCallbackFailureReason(
  stage: McpOAuthCallbackStage,
): McpOAuthErrorReason {
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

function getContinuationCookieName(state: string): string {
  const stateHash = createHash('sha256')
    .update(state)
    .digest('hex')
    .slice(0, 16);
  return `${CONTINUATION_COOKIE_PREFIX}${stateHash}`;
}

function getContinuationCookieOptions(webUrl: string) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: new URL(webUrl).protocol === 'https:',
    path: CALLBACK_PATH,
  };
}

function redirectWithMcpResult(
  webUrl: string,
  redirectPath: string,
  result: McpOAuthResult,
  state: string | null,
): NextResponse {
  const url = new URL(redirectPath, webUrl);
  url.searchParams.set('mcp', result.status);
  if (result.status === 'error' && result.reason) {
    url.searchParams.set('reason', result.reason);
  }

  const response = NextResponse.redirect(url);
  if (state) {
    response.cookies.set(getContinuationCookieName(state), '', {
      ...getContinuationCookieOptions(webUrl),
      maxAge: 0,
    });
  }
  return response;
}

export async function GET(request: NextRequest) {
  const webEnv = await bootstrapWebRuntimeEnv();
  const state = request.nextUrl.searchParams.get('state');
  const queryCode = request.nextUrl.searchParams.get('code');
  const isResume = request.nextUrl.searchParams.get('resume') === '1';
  const code =
    queryCode ??
    (state && isResume
      ? (request.cookies.get(getContinuationCookieName(state))?.value ?? null)
      : null);
  const error = request.nextUrl.searchParams.get('error');
  const errorDescription =
    request.nextUrl.searchParams.get('error_description');

  const webUrl = getPublicAppUrl(webEnv);
  const redirectPath = readRedirectPathFromState(state);
  const redirectToResult = (result: McpOAuthResult) =>
    redirectWithMcpResult(webUrl, redirectPath, result, state);

  // Kill-switch checks happen after the connection lookup: catalog
  // connections are gated by the curated flag, custom-server connections by
  // their own flag.

  // Handle OAuth errors
  if (error) {
    const reason: McpOAuthErrorReason =
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
          return redirectToResult({ status: 'error', reason });
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

    return redirectToResult({ status: 'error', reason });
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
    return redirectToResult({ status: 'error', reason: 'missing_params' });
  }

  const authResult = await authorize();
  if (!authResult.success) {
    const configuredCallbackHost = new URL(webUrl).host;
    logger.warn(
      {
        event: 'mcp_oauth_callback_auth_required',
        requestHost: request.nextUrl.host,
        configuredCallbackHost,
        callbackHostMatchesRequest:
          request.nextUrl.host === configuredCallbackHost,
      },
      'MCP OAuth callback requires sign-in before it can continue',
    );

    const callbackReturnUrl = new URL(CALLBACK_PATH, webUrl);
    callbackReturnUrl.searchParams.set('state', state);
    callbackReturnUrl.searchParams.set('resume', '1');
    const signInUrl = new URL('/sign-in', webUrl);
    signInUrl.searchParams.set(
      'redirect_url',
      `${callbackReturnUrl.pathname}${callbackReturnUrl.search}`,
    );
    const response = NextResponse.redirect(signInUrl);
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(getContinuationCookieName(state), code, {
      ...getContinuationCookieOptions(webUrl),
      maxAge: CONTINUATION_MAX_AGE_SECONDS,
    });
    return response;
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
      return redirectToResult({ status: 'error', reason: 'invalid_state' });
    }

    const resolvedConnectionId = oauthState.connectionId;
    connectionId = resolvedConnectionId;

    failureStage = 'connection_lookup';
    const connection = await db.query.mcpConnections.findFirst({
      where: eq(mcpConnections.id, resolvedConnectionId),
    });
    if (!connection) {
      return redirectToResult({ status: 'error', reason: 'not_found' });
    }
    integrationId = connection.mcpId;
    connectionRole = connection.connectionRole;

    const customTarget = isCustomMcpConnectionId(connection.mcpId)
      ? await resolveCustomMcpAuthTarget(connection.mcpId)
      : null;
    const integration = customTarget
      ? null
      : getMcpIntegration(connection.mcpId);

    if (customTarget) {
      if (webEnv.R_CUSTOM_MCP_DISABLED === true) {
        return redirectToResult({ status: 'error', reason: 'callback_failed' });
      }
    } else {
      if (webEnv.R_CURATED_INTEGRATIONS_DISABLED === true) {
        return redirectToResult({ status: 'error', reason: 'callback_failed' });
      }

      if (
        !integration ||
        !isSelfServeMcpIntegration(integration) ||
        !integration.url
      ) {
        return redirectToResult({ status: 'error', reason: 'not_found' });
      }
    }

    // Custom-server connections are deployment-scoped by construction.
    const requiresOrgAdmin = customTarget
      ? true
      : isDeploymentScopedMcpIntegration(
          integration!,
          connection.connectionRole,
        );
    const isAdmin = authResult.isAdmin;

    if (
      (requiresOrgAdmin && !isAdmin) ||
      (!requiresOrgAdmin && connection.userId !== userId)
    ) {
      return redirectToResult({ status: 'error', reason: 'not_found' });
    }

    failureStage = 'client_lookup';
    const clientInfo = await getClientInformation(resolvedConnectionId);
    if (!clientInfo) {
      return redirectToResult({ status: 'error', reason: 'not_registered' });
    }

    failureStage = 'provider_discovery';
    const tokenEndpoint = customTarget
      ? (await ensureCustomMcpServerMetadata(customTarget)).token_endpoint
      : (getMcpIntegrationOauthEndpoints(integration!)?.tokenEndpoint ??
        (await discoverOAuthEndpoints(integration!.url!)).token_endpoint);
    const redirectUri = new URL(CALLBACK_PATH, webUrl).toString();

    failureStage = 'token_exchange';
    // Catalog exchanges keep their historical call shape; custom targets add
    // the guarded fetch + resource indicator options.
    const tokens = customTarget
      ? await exchangeCodeForTokens(
          tokenEndpoint,
          code,
          oauthState.codeVerifier,
          clientInfo,
          redirectUri,
          customTarget.oauthOptions,
        )
      : await exchangeCodeForTokens(
          tokenEndpoint,
          code,
          oauthState.codeVerifier,
          clientInfo,
          redirectUri,
        );

    if (integration?.id === 'linear') {
      failureStage = 'linear_metadata';
      await hydrateLinearMcpConnectionAfterOauth({
        connection,
        tokens,
        replayToken: oauthState.replayToken,
        enabledByUserId: userId,
      });
    } else {
      failureStage = 'token_storage';
      await storeTokens(resolvedConnectionId, tokens);
    }

    // Custom servers carry their own enablement on the server row; only
    // catalog integrations write deploymentMcpEnablements.
    if (requiresOrgAdmin && integration) {
      failureStage = 'deployment_enablement';
      const defaultDisabledTools =
        getMcpIntegrationDefaultDisabledTools(integration);
      await db
        .insert(deploymentMcpEnablements)
        .values({
          mcpId: integration.id,
          enabled: true,
          enabledByUserId: userId,
          ...(defaultDisabledTools.length > 0
            ? {
                disabledTools: [...defaultDisabledTools],
              }
            : {}),
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

    return redirectToResult({ status: 'connected' });
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

    if (connectionId && !(error instanceof LinearReplayIdentityMismatchError)) {
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

    return redirectToResult({ status: 'error', reason });
  }
}
