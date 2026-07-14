import { randomBytes } from 'node:crypto';

import { db, deploymentSecrets, sql } from '@roomote/db/server';
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

let refreshPromise: Promise<string> | null = null;
let cachedAccessToken: string | null = null;

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

export async function exchangeGitLabOAuthCode(input: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
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
    expiresAt: new Date(
      Date.now() + (token.expires_in ?? 7200) * 1000,
    ).toISOString(),
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
  cachedAccessToken = connection.accessToken;
  return connection;
}

export async function resolveGitLabOAuthAccessToken(options?: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
}): Promise<string | null> {
  const connection = await readConnection();
  if (!connection || connection.status !== 'active') return null;
  if (
    !options?.forceRefresh &&
    Date.parse(connection.expiresAt) > Date.now() + 60_000
  ) {
    cachedAccessToken = connection.accessToken;
    return connection.accessToken;
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
      },
    );
    if (!response.ok) {
      await writeConnection({
        ...connection,
        status: 'reauthorization_required',
      });
      throw new Error(
        'GitLab OAuth authorization has expired and must be renewed.',
      );
    }
    const token = (await response.json()) as GitLabOAuthTokenResponse;
    const next = {
      ...connection,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? connection.refreshToken,
      expiresAt: new Date(
        Date.now() + (token.expires_in ?? 7200) * 1000,
      ).toISOString(),
      scopes: token.scope?.split(/\s+/).filter(Boolean) ?? connection.scopes,
      status: 'active' as const,
    };
    await writeConnection(next);
    cachedAccessToken = next.accessToken;
    return next.accessToken;
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export function isGitLabOAuthAccessToken(token: string): boolean {
  return token === cachedAccessToken;
}

export async function markGitLabOAuthReauthorizationRequired(): Promise<void> {
  const connection = await readConnection();
  if (connection)
    await writeConnection({
      ...connection,
      status: 'reauthorization_required',
    });
}
