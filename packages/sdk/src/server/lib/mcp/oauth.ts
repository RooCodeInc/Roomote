/**
 * MCP OAuth protocol utilities.
 *
 * Pure protocol logic: endpoint discovery, PKCE, client registration,
 * token exchange, token refresh. No database access.
 *
 * Catalog integration URLs come from the MCP_INTEGRATIONS constant and are
 * fetched with the plain global fetch. Custom-server flows target
 * operator-supplied URLs — and discovery follows URLs the *remote server*
 * supplies (WWW-Authenticate hints, authorization_servers lists) — so those
 * callers MUST pass an SSRF-guarded fetch via `OAuthRequestOptions.fetchImpl`;
 * it is used for every hop.
 */
import type {
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthServerMetadata,
  OAuthTokenEndpointAuthMethod,
} from '@roomote/types';

// Refresh token 5 minutes before expiration to avoid race conditions
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD = 'client_secret_post';

export interface OAuthRequestOptions {
  /**
   * Fetch used for every protocol request. Custom-server flows pass an
   * SSRF-guarded implementation; defaults to the global fetch.
   */
  fetchImpl?: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<Response>;
  /**
   * RFC 8707 resource indicator sent on token requests. The current MCP
   * authorization spec requires clients to send the canonical server URL;
   * per-server opt-out exists because some servers reject unknown params.
   */
  resource?: string;
}

function resolveFetch(options?: OAuthRequestOptions) {
  return (
    options?.fetchImpl ??
    ((url: string, init?: RequestInit) =>
      init === undefined ? fetch(url) : fetch(url, init))
  );
}

function buildDirectAuthorizationServerMetadataUrl(
  mcpServerUrl: string,
): string {
  return new URL(
    '/.well-known/oauth-authorization-server',
    mcpServerUrl,
  ).toString();
}

function buildAuthorizationServerMetadataUrlFromIssuer(
  issuerUrl: string,
): string {
  const url = new URL(issuerUrl);
  const issuerPath =
    url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');

  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

function buildProtectedResourceMetadataUrl(mcpServerUrl: string): string {
  const url = new URL(mcpServerUrl);
  const resourcePath =
    url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');

  url.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
  url.hash = '';

  return url.toString();
}

function getResourceMetadataUrlFromWwwAuthenticate(
  wwwAuthenticate: string | null,
): string | null {
  if (!wwwAuthenticate) {
    return null;
  }

  const match = wwwAuthenticate.match(
    /\bresource_metadata=(?:"([^"]+)"|([^,\s]+))/i,
  );

  return match?.[1] ?? match?.[2] ?? null;
}

function getFetchErrorMessage(
  metadataType: string,
  metadataUrl: string,
  response: Response,
): string {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  return `${metadataType} at ${metadataUrl} returned ${response.status}${statusText}`;
}

async function fetchOAuthServerMetadata(
  metadataUrl: string,
  options?: OAuthRequestOptions,
): Promise<OAuthServerMetadata> {
  const response = await resolveFetch(options)(metadataUrl);

  if (!response.ok) {
    throw new Error(
      getFetchErrorMessage('OAuth server metadata', metadataUrl, response),
    );
  }

  const metadata: OAuthServerMetadata = await response.json();

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error(
      `Invalid OAuth server metadata from ${metadataUrl}: missing required endpoints`,
    );
  }

  return metadata;
}

async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  options?: OAuthRequestOptions,
): Promise<OAuthProtectedResourceMetadata> {
  const response = await resolveFetch(options)(metadataUrl);

  if (!response.ok) {
    throw new Error(
      getFetchErrorMessage(
        'OAuth protected resource metadata',
        metadataUrl,
        response,
      ),
    );
  }

  return (await response.json()) as OAuthProtectedResourceMetadata;
}

async function fetchAdvertisedProtectedResourceMetadata(
  mcpServerUrl: string,
  options?: OAuthRequestOptions,
): Promise<OAuthProtectedResourceMetadata> {
  const response = await resolveFetch(options)(mcpServerUrl);
  const metadataUrl = getResourceMetadataUrlFromWwwAuthenticate(
    response.headers.get('www-authenticate'),
  );

  if (!metadataUrl) {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(
      `MCP resource at ${mcpServerUrl} did not advertise resource_metadata (status ${response.status}${statusText})`,
    );
  }

  // The metadata URL came from the server's own WWW-Authenticate header:
  // it goes through the same (possibly guarded) fetch as every other hop.
  return fetchProtectedResourceMetadata(metadataUrl, options);
}

function formatDiscoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discover OAuth protected-resource metadata from the MCP resource.
 * Returns undefined when the resource does not expose metadata.
 */
export async function discoverOAuthProtectedResourceMetadata(
  mcpServerUrl: string,
  options?: OAuthRequestOptions,
): Promise<OAuthProtectedResourceMetadata | undefined> {
  try {
    return await fetchProtectedResourceMetadata(
      buildProtectedResourceMetadataUrl(mcpServerUrl),
      options,
    );
  } catch {
    // Fall through to the advertised metadata hint.
  }

  try {
    return await fetchAdvertisedProtectedResourceMetadata(
      mcpServerUrl,
      options,
    );
  } catch {
    return undefined;
  }
}

/**
 * Discover OAuth endpoints from MCP server
 * Tries direct auth-server metadata first, then falls back to
 * protected-resource discovery when the MCP resource advertises a
 * separate authorization server.
 */
export async function discoverOAuthEndpoints(
  mcpServerUrl: string,
  options?: OAuthRequestOptions,
): Promise<OAuthServerMetadata> {
  const errors: string[] = [];

  try {
    return await fetchOAuthServerMetadata(
      buildDirectAuthorizationServerMetadataUrl(mcpServerUrl),
      options,
    );
  } catch (error) {
    errors.push(formatDiscoveryError(error));
  }

  try {
    const protectedResourceMetadata =
      await discoverOAuthProtectedResourceMetadata(mcpServerUrl, options);

    if (!protectedResourceMetadata?.authorization_servers?.length) {
      throw new Error(
        `Invalid OAuth protected resource metadata for ${mcpServerUrl}: missing authorization_servers`,
      );
    }

    for (const issuerUrl of protectedResourceMetadata.authorization_servers ??
      []) {
      try {
        // authorization_servers entries are server-supplied URLs: same
        // (possibly guarded) fetch as every other hop.
        return await fetchOAuthServerMetadata(
          buildAuthorizationServerMetadataUrlFromIssuer(issuerUrl),
          options,
        );
      } catch (error) {
        errors.push(formatDiscoveryError(error));
      }
    }
  } catch (error) {
    errors.push(formatDiscoveryError(error));
  }

  throw new Error(`Failed to discover OAuth endpoints: ${errors.join('; ')}`);
}

/**
 * Register OAuth client dynamically (RFC 7591)
 */
export async function registerOAuthClient(
  registrationEndpoint: string,
  metadata: OAuthClientMetadata,
  options?: OAuthRequestOptions,
): Promise<OAuthClientInformation> {
  const response = await resolveFetch(options)(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OAuth client registration failed: ${errorText}`);
  }

  const clientInfo: OAuthClientInformation = await response.json();

  if (!clientInfo.client_id) {
    throw new Error('Invalid client registration response: missing client_id');
  }

  return clientInfo;
}

/**
 * Prefer confidential clients when the server supports them, otherwise
 * fall back to public-client registration for providers that only support `none`.
 */
export function getPreferredTokenEndpointAuthMethod(
  serverMetadata: OAuthServerMetadata,
): OAuthTokenEndpointAuthMethod {
  const supportedMethods = serverMetadata.token_endpoint_auth_methods_supported;

  if (!supportedMethods?.length) {
    return DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;
  }

  if (supportedMethods.includes('client_secret_post')) {
    return 'client_secret_post';
  }

  if (supportedMethods.includes('client_secret_basic')) {
    return 'client_secret_basic';
  }

  if (supportedMethods.includes('none')) {
    return 'none';
  }

  return DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;
}

/**
 * Generate a cryptographically random code verifier for PKCE
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate code challenge from verifier (SHA-256)
 */
export async function generateCodeChallenge(
  codeVerifier: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Generate random state for CSRF protection
 */
export function generateState(): string {
  return crypto.randomUUID();
}

/**
 * Base64 URL encoding (without padding)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Check if an OAuth token needs to be refreshed
 */
export function tokenNeedsRefresh(expiresAt: Date | null): boolean {
  if (!expiresAt) {
    // No expiration date - assume it doesn't need refresh
    return false;
  }

  const now = Date.now();
  const expiresAtMs = expiresAt.getTime();

  // Token needs refresh if it's expired or will expire soon
  return now >= expiresAtMs - TOKEN_REFRESH_BUFFER_MS;
}

function resolveTokenEndpointAuthMethod(
  clientInfo: OAuthClientInformation,
): OAuthTokenEndpointAuthMethod {
  if (clientInfo.token_endpoint_auth_method) {
    return clientInfo.token_endpoint_auth_method;
  }

  return clientInfo.client_secret ? 'client_secret_post' : 'none';
}

function applyTokenEndpointClientAuthentication(
  body: URLSearchParams,
  headers: Record<string, string>,
  clientInfo: OAuthClientInformation,
) {
  const tokenEndpointAuthMethod = resolveTokenEndpointAuthMethod(clientInfo);

  switch (tokenEndpointAuthMethod) {
    case 'none':
      body.append('client_id', clientInfo.client_id);
      return;
    case 'client_secret_basic': {
      if (!clientInfo.client_secret) {
        throw new Error(
          'client_secret_basic requires a registered client_secret',
        );
      }

      const credentials = Buffer.from(
        `${clientInfo.client_id}:${clientInfo.client_secret}`,
      ).toString('base64');

      headers.Authorization = `Basic ${credentials}`;
      return;
    }
    case 'client_secret_post':
    default:
      body.append('client_id', clientInfo.client_id);

      if (!clientInfo.client_secret) {
        throw new Error(
          'client_secret_post requires a registered client_secret',
        );
      }

      body.append('client_secret', clientInfo.client_secret);
  }
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientInfo: OAuthClientInformation,
  redirectUri: string,
  options?: OAuthRequestOptions,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (options?.resource) {
    body.append('resource', options.resource);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  applyTokenEndpointClientAuthentication(body, headers, clientInfo);

  const response = await resolveFetch(options)(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const tokens: OAuthTokens = await response.json();

  if (!tokens.access_token) {
    throw new Error('Invalid token response: missing access_token');
  }

  return tokens;
}

/**
 * Refresh OAuth access token using refresh token
 */
export async function refreshOAuthToken(
  tokenEndpoint: string,
  clientInfo: OAuthClientInformation,
  refreshToken: string,
  options?: OAuthRequestOptions,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  if (options?.resource) {
    body.append('resource', options.resource);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  applyTokenEndpointClientAuthentication(body, headers, clientInfo);

  const response = await resolveFetch(options)(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  const tokens: OAuthTokens = await response.json();

  if (!tokens.access_token) {
    throw new Error('Invalid refresh response: missing access_token');
  }

  return tokens;
}
