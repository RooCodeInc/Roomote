import { randomBytes } from 'node:crypto';

import { db, deploymentSecrets, eq, sql } from '@roomote/db/server';
import { decryptSecrets, encryptJSON } from '@roomote/db/encryption';
import {
  OAuthRefreshError,
  createOAuthRefreshCoordinator,
  isDefinitiveOAuthErrorCode,
  readOAuthErrorCode,
} from '@roomote/source-control-oauth';

import { BITBUCKET_OAUTH_CALLBACK_PATH } from './constants';

export { BITBUCKET_OAUTH_CALLBACK_PATH };

const SECRET_NAME = 'bitbucket_deployment_oauth_connection';
const DEFAULT_SCOPES = [
  'account',
  'repository',
  'repository:write',
  'pullrequest',
  'pullrequest:write',
  'webhook',
  // CI Failure Triage reads Pipelines and step logs.
  'pipeline',
] as const;
const BITBUCKET_OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export type BitbucketOAuthConnectionStatus =
  | 'active'
  | 'reauthorization_required';

export type BitbucketOAuthConnection = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  accountId: string;
  username: string;
  scopes: string[];
  status: BitbucketOAuthConnectionStatus;
};

type BitbucketOAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scopes?: string;
};

export type BitbucketOAuthAccessToken = {
  accessToken: string;
  expiresAt: Date | null;
};

export function getBitbucketOAuthScopes(): readonly string[] {
  return DEFAULT_SCOPES;
}

export function buildBitbucketOAuthRedirectUri(appUrl: string): string {
  return new URL(
    BITBUCKET_OAUTH_CALLBACK_PATH,
    `${appUrl.replace(/\/$/, '')}/`,
  ).toString();
}

export function createBitbucketOAuthAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state?: string;
}): { url: string; state: string } {
  const state = input.state ?? randomBytes(32).toString('hex');
  const url = new URL('https://bitbucket.org/site/oauth2/authorize');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
  return { url: url.toString(), state };
}

async function readConnection(): Promise<BitbucketOAuthConnection | null> {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM deployment_secrets
      WHERE name = ${SECRET_NAME} LIMIT 1
    `);
    return rows[0]
      ? await decryptSecrets<BitbucketOAuthConnection>(rows[0].value)
      : null;
  } catch {
    return null;
  }
}

async function writeConnection(connection: BitbucketOAuthConnection) {
  const value = encryptJSON(connection);
  await db
    .insert(deploymentSecrets)
    .values({ name: SECRET_NAME, value })
    .onConflictDoUpdate({
      target: deploymentSecrets.name,
      set: { value, updatedAt: new Date() },
    });
}

type BitbucketOAuthRefreshOptions = {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  requestTimeoutMs?: number;
};

const refreshCoordinator = createOAuthRefreshCoordinator<
  BitbucketOAuthConnection,
  BitbucketOAuthAccessToken,
  BitbucketOAuthRefreshOptions
>({
  readConnection,
  writeConnection,
  deleteConnection: async () => {
    await db
      .delete(deploymentSecrets)
      .where(eq(deploymentSecrets.name, SECRET_NAME));
  },
  isFresh: (connection) =>
    Date.parse(connection.expiresAt) > Date.now() + 60_000,
  refresh: refreshBitbucketOAuthConnection,
  toResult: (connection) =>
    toAccessTokenResult(connection.accessToken, connection.expiresAt),
});

export async function getBitbucketOAuthConnection() {
  return readConnection();
}

export async function deleteBitbucketOAuthConnection(): Promise<void> {
  await refreshCoordinator.delete();
}

export function isBitbucketOAuthAccessToken(token: string): boolean {
  return refreshCoordinator.isAccessToken(token);
}

function toAccessTokenResult(
  accessToken: string,
  expiresAt: string,
): BitbucketOAuthAccessToken {
  const parsedExpiresAt = new Date(expiresAt);
  return {
    accessToken,
    expiresAt: Number.isNaN(parsedExpiresAt.getTime()) ? null : parsedExpiresAt,
  };
}

export async function exchangeBitbucketOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<BitbucketOAuthConnection> {
  const response = await (input.fetchImpl ?? fetch)(
    'https://bitbucket.org/site/oauth2/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(
        input.requestTimeoutMs ?? BITBUCKET_OAUTH_REQUEST_TIMEOUT_MS,
      ),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Bitbucket OAuth token exchange failed: ${response.status} ${response.statusText}`,
    );
  }
  const token = (await response.json()) as BitbucketOAuthTokenResponse;
  if (!token.access_token || !token.refresh_token) {
    throw new Error(
      'Bitbucket OAuth did not return an access and refresh token.',
    );
  }

  const connection: BitbucketOAuthConnection = {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(
      Date.now() + (token.expires_in ?? 3600) * 1000,
    ).toISOString(),
    accountId: '',
    username: '',
    scopes: token.scopes?.split(/\s+/).filter(Boolean) ?? [...DEFAULT_SCOPES],
    status: 'active',
  };
  try {
    const identity = await (input.fetchImpl ?? fetch)(
      'https://api.bitbucket.org/2.0/user',
      { headers: { Authorization: `Bearer ${connection.accessToken}` } },
    );
    if (identity.ok) {
      const user = (await identity.json()) as {
        account_id?: string;
        username?: string;
        nickname?: string;
      };
      connection.accountId = user.account_id ?? '';
      connection.username = user.username ?? user.nickname ?? '';
    }
  } catch {
    // The token exchange remains valid if the identity lookup is temporarily unavailable.
  }
  await writeConnection(connection);
  refreshCoordinator.remember(connection);
  return connection;
}

async function refreshBitbucketOAuthConnection(
  connection: BitbucketOAuthConnection,
  options: BitbucketOAuthRefreshOptions | undefined,
): Promise<BitbucketOAuthConnection> {
  const response = await (options?.fetchImpl ?? fetch)(
    'https://bitbucket.org/site/oauth2/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${connection.clientId}:${connection.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connection.refreshToken,
      }),
      signal: AbortSignal.timeout(
        options?.requestTimeoutMs ?? BITBUCKET_OAUTH_REQUEST_TIMEOUT_MS,
      ),
    },
  );
  if (!response.ok) {
    const oauthError = await readOAuthErrorCode(response);
    throw new OAuthRefreshError(
      `Bitbucket OAuth refresh failed: ${response.status} ${response.statusText}`,
      isDefinitiveOAuthErrorCode(oauthError),
    );
  }
  const token = (await response.json()) as BitbucketOAuthTokenResponse;
  if (!token.access_token)
    throw new Error('Bitbucket OAuth refresh did not return an access token.');
  return {
    ...connection,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? connection.refreshToken,
    expiresAt: new Date(
      Date.now() + (token.expires_in ?? 3600) * 1000,
    ).toISOString(),
    status: 'active',
  };
}

export async function resolveBitbucketOAuthAccessTokenWithMetadata(
  options?: BitbucketOAuthRefreshOptions,
): Promise<BitbucketOAuthAccessToken | null> {
  return refreshCoordinator.resolve(options);
}

export async function resolveBitbucketOAuthAccessToken(options?: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  requestTimeoutMs?: number;
}): Promise<string | null> {
  const result = await resolveBitbucketOAuthAccessTokenWithMetadata(options);
  return result?.accessToken ?? null;
}

export async function markBitbucketOAuthReauthorizationRequired() {
  const connection = await readConnection();
  if (connection)
    await writeConnection({
      ...connection,
      status: 'reauthorization_required',
    });
}
