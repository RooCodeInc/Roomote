/**
 * MCP data access layer.
 *
 * All database operations for MCP connections, OAuth tokens, and state
 * live here. Pure OAuth protocol logic (discovery, PKCE, token exchange)
 * lives in ./oauth.ts with no DB dependencies.
 */
import {
  eq,
  db,
  mcpConnections,
  mcpOauthReplays,
  oauthState,
} from '@roomote/db/server';
import { encrypt, decrypt, decryptText } from '@roomote/db/encryption';
import type {
  OAuthTokens,
  OAuthClientInformation,
  McpConnectionOAuthConfig,
  McpConnectionRole,
} from '@roomote/types';

// Minimum base64 length for an AES-256-GCM encrypted value (salt+iv+tag = 64 bytes → 88 base64 chars)
const MIN_ENCRYPTED_LENGTH = 88;

function isEncrypted(value: string): boolean {
  return (
    value.length >= MIN_ENCRYPTED_LENGTH && /^[A-Za-z0-9+/=]+$/.test(value)
  );
}

/**
 * Store OAuth state for PKCE flow with the provided state ID
 */
export async function storeOAuthStateWithId(
  state: string,
  connectionId: string,
  codeVerifier: string,
  replayToken?: string,
): Promise<void> {
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  await db.insert(oauthState).values({
    id: state,
    connectionId,
    codeVerifier,
    replayToken,
    expiresAt,
  });
}

/**
 * Get and consume OAuth state atomically.
 * Uses DELETE ... RETURNING to prevent TOCTOU races where two concurrent
 * requests could both consume the same state record.
 */
export async function consumeOAuthState(state: string): Promise<{
  connectionId: string;
  codeVerifier: string;
  replayToken?: string | null;
} | null> {
  const [record] = await db
    .delete(oauthState)
    .where(eq(oauthState.id, state))
    .returning();

  if (!record) {
    return null;
  }

  // Check if expired (record is already deleted, so just reject it)
  if (record.expiresAt < Date.now()) {
    return null;
  }

  // Decrypt code verifier; gracefully handle existing plaintext values
  const rawVerifier = record.codeVerifier;
  if (!rawVerifier) {
    return null;
  }
  let codeVerifier: string = rawVerifier;
  if (isEncrypted(rawVerifier)) {
    try {
      codeVerifier = decryptText(rawVerifier);
    } catch {
      // Fallback: treat as plaintext
    }
  }

  return {
    connectionId: record.connectionId,
    codeVerifier,
    replayToken: record.replayToken,
  };
}

export async function createMcpOauthReplay(input: {
  token: string;
  userId?: string | null;
  mcpId: string;
  connectionRole: McpConnectionRole;
  connectionId?: string | null;
  sessionId?: string | null;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  redirectTo?: string | null;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(mcpOauthReplays).values({
    token: input.token,
    userId: input.userId ?? null,
    mcpId: input.mcpId,
    connectionRole: input.connectionRole,
    connectionId: input.connectionId ?? null,
    sessionId: input.sessionId ?? null,
    payload: input.payload ?? null,
    metadata: input.metadata ?? {},
    redirectTo: input.redirectTo ?? null,
    expiresAt: input.expiresAt,
  });
}

export async function consumeMcpOauthReplay(token: string) {
  const [record] = await db
    .delete(mcpOauthReplays)
    .where(eq(mcpOauthReplays.token, token))
    .returning();

  if (!record) {
    return null;
  }

  if (record.expiresAt < new Date()) {
    return null;
  }

  return record;
}

export async function getMcpOauthReplay(token: string) {
  const record = await db.query.mcpOauthReplays.findFirst({
    where: eq(mcpOauthReplays.token, token),
  });

  if (!record || record.expiresAt < new Date()) {
    return null;
  }

  return record;
}

export async function updateMcpOauthReplay(
  token: string,
  input: {
    connectionId?: string | null;
    userId?: string | null;
    redirectTo?: string | null;
  },
) {
  const [record] = await db
    .update(mcpOauthReplays)
    .set({
      ...(input.connectionId !== undefined
        ? { connectionId: input.connectionId }
        : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.redirectTo !== undefined
        ? { redirectTo: input.redirectTo }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(mcpOauthReplays.token, token))
    .returning();

  return record ?? null;
}

/**
 * Store OAuth tokens on a connection
 */
export async function storeTokens(
  connectionId: string,
  tokens: OAuthTokens,
): Promise<void> {
  const tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  await db
    .update(mcpConnections)
    .set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      tokenExpiresAt,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      authStatus: 'authenticated',
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(mcpConnections.id, connectionId));
}

/**
 * Get stored tokens for a connection
 */
async function getStoredTokens(
  connectionId: string,
): Promise<OAuthTokens | undefined> {
  const connection = await db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.id, connectionId),
  });

  if (!connection?.accessToken) {
    return undefined;
  }

  const result: OAuthTokens = {
    access_token: decryptText(connection.accessToken),
    token_type: 'Bearer',
  };

  if (connection.refreshToken) {
    result.refresh_token = decryptText(connection.refreshToken);
  }

  if (connection.tokenExpiresAt) {
    const remainingMs = connection.tokenExpiresAt.getTime() - Date.now();
    if (remainingMs > 0) {
      result.expires_in = Math.floor(remainingMs / 1000);
    }
    // When remainingMs <= 0, expires_in is omitted → caller treats as expired
  } else {
    // No expiration set by OAuth server — token does not expire.
    // Use -1 sentinel to distinguish from "expired" (omitted expires_in).
    result.expires_in = -1;
  }

  if (connection.scopes && connection.scopes.length > 0) {
    result.scope = connection.scopes.join(' ');
  }

  return result;
}

/**
 * Check if a connection has valid OAuth tokens
 */
export async function hasValidOAuthTokens(
  connectionId: string,
): Promise<boolean> {
  const connection = await db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.id, connectionId),
  });

  if (!connection?.accessToken) {
    return false;
  }

  // If no expiration or not expired, tokens are valid
  if (!connection.tokenExpiresAt || connection.tokenExpiresAt > new Date()) {
    return true;
  }

  // Tokens expired - check if we have refresh token
  return !!connection.refreshToken;
}

/**
 * Store client information for dynamic registration
 * Also stores the redirect_uri used during registration for future validation
 */
export async function storeClientInformation(
  connectionId: string,
  clientInfo: OAuthClientInformation,
  redirectUri: string,
): Promise<void> {
  const existingConnection = await db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.id, connectionId),
    columns: {
      authConfig: true,
    },
  });

  const authConfig: McpConnectionOAuthConfig = {
    ...(existingConnection?.authConfig &&
    typeof existingConnection.authConfig === 'object'
      ? existingConnection.authConfig
      : {}),
    type: 'oauth_client',
    registered_redirect_uri: redirectUri,
    client_id: clientInfo.client_id,
    client_secret: clientInfo.client_secret
      ? encrypt(clientInfo.client_secret)
      : undefined,
    client_id_issued_at: clientInfo.client_id_issued_at,
    client_secret_expires_at: clientInfo.client_secret_expires_at,
    token_endpoint_auth_method: clientInfo.token_endpoint_auth_method,
  };

  await db
    .update(mcpConnections)
    .set({
      authConfig,
      updatedAt: new Date(),
    })
    .where(eq(mcpConnections.id, connectionId));
}

/**
 * Update the auth status of a connection
 */
export async function updateAuthStatus(
  connectionId: string,
  authStatus: 'pending' | 'authenticated' | 'error',
  enabled?: boolean,
): Promise<void> {
  const set: Record<string, unknown> = {
    authStatus,
    updatedAt: new Date(),
  };
  if (enabled !== undefined) {
    set.enabled = enabled;
  }
  await db
    .update(mcpConnections)
    .set(set)
    .where(eq(mcpConnections.id, connectionId));
}

/**
 * Get stored client information
 */
export async function getClientInformation(
  connectionId: string,
): Promise<OAuthClientInformation | undefined> {
  const connection = await db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.id, connectionId),
  });

  if (!connection?.authConfig) {
    return undefined;
  }

  const config = connection.authConfig;
  if ('type' in config && config.type === 'oauth_client' && config.client_id) {
    const tokenEndpointAuthMethod =
      config.token_endpoint_auth_method ??
      (config.client_secret ? 'client_secret_post' : 'none');

    return {
      client_id: config.client_id,
      client_secret: config.client_secret
        ? decrypt(config.client_secret)
        : undefined,
      client_id_issued_at: config.client_id_issued_at,
      client_secret_expires_at: config.client_secret_expires_at,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    };
  }

  if (
    connection.mcpId === 'linear' &&
    typeof process.env.LINEAR_CLIENT_ID === 'string' &&
    process.env.LINEAR_CLIENT_ID &&
    typeof process.env.LINEAR_CLIENT_SECRET === 'string' &&
    process.env.LINEAR_CLIENT_SECRET
  ) {
    return {
      client_id: process.env.LINEAR_CLIENT_ID,
      client_secret: process.env.LINEAR_CLIENT_SECRET,
      token_endpoint_auth_method: 'client_secret_post',
    };
  }

  return undefined;
}

/**
 * Get a valid access token for an MCP connection, refreshing if needed.
 * Returns undefined if no tokens are available.
 *
 * This function bridges the data layer and the OAuth protocol layer:
 * it reads stored tokens, checks expiration, and delegates to the
 * protocol functions for refresh when needed.
 */
export async function getValidAccessToken(
  connectionId: string,
  mcpUrl: string,
): Promise<string | undefined> {
  const { discoverOAuthEndpoints, refreshOAuthToken, tokenNeedsRefresh } =
    await import('./oauth');

  const storedTokens = await getStoredTokens(connectionId);
  if (!storedTokens) {
    return undefined;
  }

  let accessToken = storedTokens.access_token;

  // getStoredTokens() returns:
  //   expires_in > 0  → seconds remaining
  //   expires_in = -1 → no expiration (token never expires, skip refresh)
  //   expires_in omitted → already expired, must refresh
  const noExpiration = storedTokens.expires_in === -1;
  const tokenExpired = !noExpiration && !storedTokens.expires_in;
  const expiresAt =
    storedTokens.expires_in && storedTokens.expires_in > 0
      ? new Date(Date.now() + storedTokens.expires_in * 1000)
      : null;
  const needsRefresh =
    !noExpiration && (tokenExpired || tokenNeedsRefresh(expiresAt));

  if (needsRefresh) {
    if (storedTokens.refresh_token) {
      try {
        const clientInfo = await getClientInformation(connectionId);
        if (clientInfo) {
          const serverMetadata = await discoverOAuthEndpoints(mcpUrl);
          const newTokens = await refreshOAuthToken(
            serverMetadata.token_endpoint,
            clientInfo,
            storedTokens.refresh_token,
          );
          // Preserve existing refresh token if server didn't issue a new one (RFC 6749 §6)
          if (!newTokens.refresh_token) {
            newTokens.refresh_token = storedTokens.refresh_token;
          }
          await storeTokens(connectionId, newTokens);
          accessToken = newTokens.access_token;
        }
      } catch (error) {
        console.error(
          `[getValidAccessToken] Token refresh failed:`,
          error instanceof Error ? error.message : String(error),
        );
        // Fall through — try with existing (potentially expired) token
      }
    } else {
      // Token is expired and there's no refresh token available.
      return undefined;
    }
  }

  return accessToken;
}
