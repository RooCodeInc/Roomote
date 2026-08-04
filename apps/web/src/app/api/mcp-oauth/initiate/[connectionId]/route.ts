import { NextResponse } from 'next/server';

import { db, mcpConnections, eq } from '@roomote/db/server';
import {
  discoverOAuthEndpoints,
  discoverOAuthProtectedResourceMetadata,
  registerOAuthClient,
  getPreferredTokenEndpointAuthMethod,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  storeOAuthStateWithId,
  storeClientInformation,
  getClientInformation,
} from '@roomote/sdk/server';
import type {
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthServerMetadata,
} from '@roomote/types';
import {
  type McpConnectionRole,
  getMcpIntegrationAuthorizationParameters,
  getMcpIntegrationOauthEndpoints,
  getMcpIntegrationOauthScopeMode,
  getMcpIntegrationOauthScopeSeparator,
  getMcpIntegrationOauthScopes,
  getMcpIntegration,
  type McpIntegration,
  isDeploymentScopedMcpIntegration,
  isSelfServeMcpIntegration,
  PRODUCT_NAME,
} from '@roomote/types';
import { authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import { resolveDeploymentStaticOauthClientInformation } from '@/lib/server/deployment-static-oauth';

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

function encodeStateWithRedirect(state: string, redirectPath: string): string {
  if (redirectPath === DEFAULT_REDIRECT_PATH) {
    return state;
  }

  const encodedPath = Buffer.from(redirectPath, 'utf8').toString('base64url');
  return `${state}${REDIRECT_STATE_DELIMITER}${encodedPath}`;
}

function isReadOnlyScope(scope: string): boolean {
  const normalized = scope.trim().toLowerCase();

  return (
    normalized === 'openid' ||
    normalized === 'profile' ||
    normalized === 'email' ||
    normalized === 'offline_access' ||
    normalized === 'read' ||
    normalized.startsWith('read:') ||
    normalized.endsWith(':read')
  );
}

function getRequestedScope(
  scopeList: string[] | undefined,
  integration: McpIntegration,
  connectionRole: McpConnectionRole = 'default',
): string | undefined {
  const explicitScopes = getMcpIntegrationOauthScopes(
    integration,
    connectionRole,
  );
  if (explicitScopes?.length) {
    return explicitScopes.join(
      getMcpIntegrationOauthScopeSeparator(integration),
    );
  }

  if (!scopeList?.length) {
    return undefined;
  }

  const requestedScopes =
    getMcpIntegrationOauthScopeMode(integration, connectionRole) === 'read-only'
      ? scopeList.filter(isReadOnlyScope)
      : scopeList;

  const uniqueScopes = Array.from(
    new Set(requestedScopes.map((scope) => scope.trim()).filter(Boolean)),
  );

  return uniqueScopes.length > 0
    ? uniqueScopes.join(getMcpIntegrationOauthScopeSeparator(integration))
    : undefined;
}

function getOAuthServerMetadataOverride(
  integration: McpIntegration,
): OAuthServerMetadata | undefined {
  const endpoints = getMcpIntegrationOauthEndpoints(integration);
  if (!endpoints) {
    return undefined;
  }

  return {
    issuer: new URL(endpoints.authorizationEndpoint).origin,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    ...(endpoints.registrationEndpoint
      ? { registration_endpoint: endpoints.registrationEndpoint }
      : {}),
    scopes_supported: getMcpIntegrationOauthScopes(integration),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: endpoints.tokenEndpointAuthMethod
      ? [endpoints.tokenEndpointAuthMethod]
      : ['client_secret_post', 'client_secret_basic'],
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const webEnv = await bootstrapWebRuntimeEnv();
  const webUrl = getPublicAppUrl(webEnv);
  const requestUrl = new URL(request.url);
  const redirectPath =
    sanitizeRedirectPath(requestUrl.searchParams.get('redirectTo')) ??
    DEFAULT_REDIRECT_PATH;
  const replayToken = requestUrl.searchParams.get('replayToken');

  if (webEnv.R_CURATED_INTEGRATIONS_DISABLED === true) {
    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', 'disabled'),
    );
  }

  const authResult = await authorize();
  if (!authResult.success) {
    return NextResponse.redirect(
      withMcpQuery(webUrl, redirectPath, 'error', 'unauthorized'),
    );
  }

  const { userId } = authResult;

  try {
    const connection = await db.query.mcpConnections.findFirst({
      where: eq(mcpConnections.id, connectionId),
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

    const serverMetadataOverride = getOAuthServerMetadataOverride(integration);
    const [serverMetadata, protectedResourceMetadata] = serverMetadataOverride
      ? [serverMetadataOverride, undefined]
      : await Promise.all([
          discoverOAuthEndpoints(integration.url),
          discoverOAuthProtectedResourceMetadata(integration.url),
        ]);
    const redirectUri = new URL('/api/mcp-oauth/callback', webUrl).toString();
    const requestedScope = getRequestedScope(
      protectedResourceMetadata?.scopes_supported ??
        serverMetadata.scopes_supported,
      integration,
      connection.connectionRole,
    );

    const staticClientInfo =
      await resolveDeploymentStaticOauthClientInformation(webEnv, integration);
    let clientInfo: OAuthClientInformation | undefined;

    if (staticClientInfo) {
      // Configured deployment credentials are authoritative. Replacing the
      // stored client also migrates connections created by the old dynamic
      // registration flow before their next authorization or token refresh.
      await storeClientInformation(connectionId, staticClientInfo, redirectUri);
      clientInfo = staticClientInfo;
    } else {
      clientInfo = await getClientInformation(connectionId, {
        expectedRedirectUri: redirectUri,
      });
    }

    if (!clientInfo && serverMetadata.registration_endpoint) {
      // Dynamic client registration (RFC 7591)
      const tokenEndpointAuthMethod =
        getPreferredTokenEndpointAuthMethod(serverMetadata);
      const clientMetadata: OAuthClientMetadata = {
        client_name: `${PRODUCT_NAME} - ${integration.name}`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        ...(requestedScope ? { scope: requestedScope } : {}),
      };

      const registeredClient = await registerOAuthClient(
        serverMetadata.registration_endpoint,
        clientMetadata,
      );

      const storedClientInfo: OAuthClientInformation = {
        ...registeredClient,
        token_endpoint_auth_method:
          registeredClient.token_endpoint_auth_method ??
          tokenEndpointAuthMethod,
      };

      await storeClientInformation(connectionId, storedClientInfo, redirectUri);
      clientInfo = storedClientInfo;
    }

    if (!clientInfo) {
      return NextResponse.redirect(
        withMcpQuery(webUrl, redirectPath, 'error', 'registration_failed'),
      );
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = encodeStateWithRedirect(generateState(), redirectPath);

    await storeOAuthStateWithId(
      state,
      connectionId,
      codeVerifier,
      replayToken ?? undefined,
    );

    const authUrl = new URL(serverMetadata.authorization_endpoint);
    authUrl.searchParams.set('client_id', clientInfo.client_id);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (requestedScope) {
      authUrl.searchParams.set('scope', requestedScope);
    }
    for (const parameter of getMcpIntegrationAuthorizationParameters(
      integration,
      connection.connectionRole,
    )) {
      authUrl.searchParams.set(parameter.name, parameter.value);
    }

    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    console.error('[MCP OAuth] Error initiating OAuth flow:', error);
    return NextResponse.redirect(withMcpQuery(webUrl, redirectPath, 'error'));
  }
}
