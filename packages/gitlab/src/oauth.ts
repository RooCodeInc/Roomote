import { randomBytes } from 'node:crypto';

import { db, deploymentSecrets, eq, sql } from '@roomote/db/server';
import { decryptSecrets, encryptJSON } from '@roomote/db/encryption';

const SECRET_NAME = 'gitlab_deployment_oauth_connection';
// GitLab OAuth applications use `api` for repository read/write access.
// `read_repository` and `write_repository` are deploy/project token scopes,
// not valid OAuth scopes.
const DEFAULT_SCOPES = ['api'] as const;

export type GitLabOAuthConnectionStatus = 'active' | 'reauthorization_required';

export type GitLabOAuthConnection = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  /**
   * Access-token lifetime reported by the instance. Absent on connections
   * written before adaptive refresh, which fall back to the default skew.
   */
  expiresInSeconds?: number;
  scopes: string[];
  status: GitLabOAuthConnectionStatus;
};

type GitLabOAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
  scope?: string;
};

export type GitLabOAuthAccessToken = {
  accessToken: string;
  /** Null when the stored expiry is unreadable; callers keep their default cadence. */
  expiresAt: Date | null;
};

/** Proactive OAuth refresh window for GitLab's default ~2h access tokens. */
const OAUTH_ACCESS_TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;

/** GitLab's default access-token lifetime, used when none is reported. */
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 7200;
const GITLAB_OAUTH_REQUEST_TIMEOUT_MS = 15_000;

type GitLabOAuthErrorResponse = {
  error?: string;
};

function isDefinitiveOAuthError(error: string | undefined): boolean {
  return ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(
    error ?? '',
  );
}

/** Expiry fields for a freshly issued access token, in the instance's own terms. */
function accessTokenLifetime(token: GitLabOAuthTokenResponse): {
  expiresAt: string;
  expiresInSeconds: number;
} {
  const expiresInSeconds =
    token.expires_in ?? DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;

  return {
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    expiresInSeconds,
  };
}

/**
 * Self-managed instances can configure a much shorter OAuth lifetime than the
 * ~2h default. A fixed skew wider than the lifetime itself would refresh on
 * every resolve, so cap it at a quarter of the token's life.
 */
function refreshSkewMsFor(connection: GitLabOAuthConnection): number {
  const lifetimeMs = (connection.expiresInSeconds ?? 0) * 1000;

  return lifetimeMs > 0
    ? Math.min(OAUTH_ACCESS_TOKEN_REFRESH_SKEW_MS, lifetimeMs / 4)
    : OAUTH_ACCESS_TOKEN_REFRESH_SKEW_MS;
}

let refreshPromise: Promise<GitLabOAuthAccessToken | null> | null = null;
let deletionPromise: Promise<void> | null = null;
let connectionGeneration = 0;
let cachedAccessToken: string | null = null;
// A rotate leaves in-flight callers holding the token they resolved a moment
// ago. Keep it so those calls still pick the Bearer header.
let previousAccessToken: string | null = null;

function rememberAccessToken(accessToken: string): void {
  if (cachedAccessToken && cachedAccessToken !== accessToken) {
    previousAccessToken = cachedAccessToken;
  }
  cachedAccessToken = accessToken;
}

function clearCachedAccessToken(): void {
  cachedAccessToken = null;
  previousAccessToken = null;
}

function parseConnectionExpiresAt(expiresAt: string): Date | null {
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function toAccessTokenResult(
  accessToken: string,
  expiresAt: string,
): GitLabOAuthAccessToken {
  rememberAccessToken(accessToken);
  return { accessToken, expiresAt: parseConnectionExpiresAt(expiresAt) };
}

function tokenEndpoint(baseUrl: string): string {
  return new URL('oauth/token', `${baseUrl.replace(/\/$/, '')}/`).toString();
}

export function getGitLabOAuthScopes(): readonly string[] {
  return DEFAULT_SCOPES;
}

export function buildGitLabOAuthRedirectUri(appUrl: string): string {
  return new URL(
    '/api/source-control/gitlab/oauth/callback',
    `${appUrl.replace(/\/$/, '')}/`,
  ).toString();
}

export function createGitLabOAuthAuthorizationUrl(input: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state?: string;
}): { url: string; state: string } {
  const state = input.state ?? randomBytes(32).toString('hex');
  const url = new URL(
    'oauth/authorize',
    `${input.baseUrl.replace(/\/$/, '')}/`,
  );
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
  return { url: url.toString(), state };
}

async function readConnection(): Promise<GitLabOAuthConnection | null> {
  // Use raw SQL here because some deployed DB package versions expose the
  // relation without the current column metadata. PAT resolution remains
  // available when the deployment-secrets table is unavailable.
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value
      FROM deployment_secrets
      WHERE name = ${SECRET_NAME}
      LIMIT 1
    `);
    const row = rows[0];
    return row ? await decryptSecrets<GitLabOAuthConnection>(row.value) : null;
  } catch {
    return null;
  }
}

async function writeConnection(
  connection: GitLabOAuthConnection,
): Promise<void> {
  const value = encryptJSON(connection);
  await db
    .insert(deploymentSecrets)
    .values({ name: SECRET_NAME, value })
    .onConflictDoUpdate({
      target: deploymentSecrets.name,
      set: { value, updatedAt: new Date() },
    });
}

export async function getGitLabOAuthConnection(): Promise<GitLabOAuthConnection | null> {
  return readConnection();
}

export async function deleteGitLabOAuthConnection(): Promise<void> {
  if (!deletionPromise) {
    connectionGeneration += 1;
    const inFlightRefresh = refreshPromise;
    deletionPromise = (async () => {
      await inFlightRefresh?.catch(() => undefined);
      await db
        .delete(deploymentSecrets)
        .where(eq(deploymentSecrets.name, SECRET_NAME));
      refreshPromise = null;
      clearCachedAccessToken();
    })();
  }

  try {
    await deletionPromise;
  } finally {
    deletionPromise = null;
  }
}

export async function exchangeGitLabOAuthCode(input: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<GitLabOAuthConnection> {
  const response = await (input.fetchImpl ?? fetch)(
    tokenEndpoint(input.baseUrl),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(
        input.requestTimeoutMs ?? GITLAB_OAUTH_REQUEST_TIMEOUT_MS,
      ),
    },
  );
  if (!response.ok)
    throw new Error(
      `GitLab OAuth token exchange failed: ${response.status} ${response.statusText}`,
    );
  const token = (await response.json()) as GitLabOAuthTokenResponse;
  if (!token.access_token || !token.refresh_token)
    throw new Error('GitLab OAuth did not return an access and refresh token.');

  const connection: GitLabOAuthConnection = {
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    accountId: '',
    username: '',
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    ...accessTokenLifetime(token),
    scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [...DEFAULT_SCOPES],
    status: 'active',
  };
  try {
    const userResponse = await (input.fetchImpl ?? fetch)(
      new URL('api/v4/user', `${input.baseUrl.replace(/\/$/, '')}/`),
      { headers: { Authorization: `Bearer ${connection.accessToken}` } },
    );
    if (userResponse.ok) {
      const user = (await userResponse.json()) as {
        id?: number;
        username?: string;
      };
      connection.accountId = user.id === undefined ? '' : String(user.id);
      connection.username = user.username ?? '';
    }
  } catch {
    // Token exchange is still valid when the identity lookup is temporarily unavailable.
  }
  await writeConnection(connection);
  rememberAccessToken(connection.accessToken);
  return connection;
}

/** Resolve OAuth access token + expiry, refreshing inside the skew window. */
export async function resolveGitLabOAuthAccessTokenWithMetadata(options?: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  requestTimeoutMs?: number;
}): Promise<GitLabOAuthAccessToken | null> {
  if (deletionPromise) {
    await deletionPromise;
    return null;
  }
  const generation = connectionGeneration;
  const connection = await readConnection();
  if (generation !== connectionGeneration || deletionPromise) {
    await deletionPromise;
    return null;
  }
  if (!connection || connection.status !== 'active') return null;
  if (
    !options?.forceRefresh &&
    Date.parse(connection.expiresAt) > Date.now() + refreshSkewMsFor(connection)
  ) {
    return toAccessTokenResult(connection.accessToken, connection.expiresAt);
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const response = await (options?.fetchImpl ?? fetch)(
      tokenEndpoint(connection.baseUrl),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: connection.clientId,
          client_secret: connection.clientSecret,
          refresh_token: connection.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(
          options?.requestTimeoutMs ?? GITLAB_OAUTH_REQUEST_TIMEOUT_MS,
        ),
      },
    );
    if (!response.ok) {
      if (generation !== connectionGeneration) return null;

      const oauthError = await response
        .clone()
        .json()
        .then((body) => (body as GitLabOAuthErrorResponse).error)
        .catch(() => undefined);

      if (isDefinitiveOAuthError(oauthError)) {
        const latest = await readConnection();
        if (
          latest?.status === 'active' &&
          latest.accessToken !== connection.accessToken &&
          Date.parse(latest.expiresAt) > Date.now() + refreshSkewMsFor(latest)
        ) {
          return toAccessTokenResult(latest.accessToken, latest.expiresAt);
        }
        await writeConnection({
          ...(latest ?? connection),
          status: 'reauthorization_required',
        });
        throw new Error(
          'GitLab OAuth authorization has expired and must be renewed.',
        );
      }

      throw new Error(
        `GitLab OAuth refresh failed: ${response.status} ${response.statusText}`,
      );
    }
    const token = (await response.json()) as GitLabOAuthTokenResponse;
    const next = {
      ...connection,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? connection.refreshToken,
      ...accessTokenLifetime(token),
      scopes: token.scope?.split(/\s+/).filter(Boolean) ?? connection.scopes,
      status: 'active' as const,
    };
    if (generation !== connectionGeneration) return null;
    await writeConnection(next);
    return toAccessTokenResult(next.accessToken, next.expiresAt);
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function resolveGitLabOAuthAccessToken(options?: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  requestTimeoutMs?: number;
}): Promise<string | null> {
  const result = await resolveGitLabOAuthAccessTokenWithMetadata(options);
  return result?.accessToken ?? null;
}

/**
 * Bearer (OAuth) vs PRIVATE-TOKEN. Only tokens this process actually minted
 * qualify: guessing from prefixes misclassifies deploy tokens, CI job tokens,
 * and self-managed instances with a customised PAT prefix.
 */
export function isGitLabOAuthAccessToken(token: string): boolean {
  if (!token) {
    return false;
  }
  return token === cachedAccessToken || token === previousAccessToken;
}

export async function markGitLabOAuthReauthorizationRequired(): Promise<void> {
  const connection = await readConnection();
  if (connection)
    await writeConnection({
      ...connection,
      status: 'reauthorization_required',
    });
}
