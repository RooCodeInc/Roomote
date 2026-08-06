import { randomBytes } from 'node:crypto';

import { db, deploymentSecrets, eq, sql } from '@roomote/db/server';
import { decryptSecrets, encryptJSON } from '@roomote/db/encryption';

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

let refreshPromise: Promise<string | null> | null = null;
let deletionPromise: Promise<void> | null = null;
let connectionGeneration = 0;
let cachedAccessToken: string | null = null;

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

export async function getBitbucketOAuthConnection() {
  return readConnection();
}

export async function deleteBitbucketOAuthConnection(): Promise<void> {
  if (!deletionPromise) {
    connectionGeneration += 1;
    const inFlightRefresh = refreshPromise;
    deletionPromise = (async () => {
      await inFlightRefresh?.catch(() => undefined);
      await db
        .delete(deploymentSecrets)
        .where(eq(deploymentSecrets.name, SECRET_NAME));
      refreshPromise = null;
      cachedAccessToken = null;
    })();
  }

  try {
    await deletionPromise;
  } finally {
    deletionPromise = null;
  }
}

export function isBitbucketOAuthAccessToken(token: string): boolean {
  return token === cachedAccessToken;
}

export async function exchangeBitbucketOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
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
  cachedAccessToken = connection.accessToken;
  return connection;
}

export async function resolveBitbucketOAuthAccessToken(options?: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
}): Promise<string | null> {
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
    Date.parse(connection.expiresAt) > Date.now() + 60_000
  ) {
    cachedAccessToken = connection.accessToken;
    return connection.accessToken;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let requiresReauthorization = false;
    try {
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
        },
      );
      if (!response.ok) {
        requiresReauthorization = [400, 401, 403].includes(response.status);
        throw new Error(
          `Bitbucket OAuth refresh failed: ${response.status} ${response.statusText}`,
        );
      }
      const token = (await response.json()) as BitbucketOAuthTokenResponse;
      if (!token.access_token)
        throw new Error(
          'Bitbucket OAuth refresh did not return an access token.',
        );
      const next = {
        ...connection,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? connection.refreshToken,
        expiresAt: new Date(
          Date.now() + (token.expires_in ?? 3600) * 1000,
        ).toISOString(),
        status: 'active' as const,
      };
      if (generation !== connectionGeneration) return null;
      await writeConnection(next);
      cachedAccessToken = next.accessToken;
      return next.accessToken;
    } catch (error) {
      if (requiresReauthorization) {
        try {
          if (generation !== connectionGeneration) return null;
          await writeConnection({
            ...connection,
            status: 'reauthorization_required',
          });
        } catch {
          // Preserve the original refresh error when persistence is unavailable.
        }
      }
      throw error;
    }
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function markBitbucketOAuthReauthorizationRequired() {
  const connection = await readConnection();
  if (connection)
    await writeConnection({
      ...connection,
      status: 'reauthorization_required',
    });
}
