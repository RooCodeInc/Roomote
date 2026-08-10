import { randomBytes } from 'node:crypto';

import { db, deploymentSecrets, eq } from '@roomote/db/server';
import { decryptSecrets, encryptJSON } from '@roomote/db/encryption';

const SECRET_NAME = 'gitea_deployment_oauth_connection';
const DEFAULT_SCOPES = [
  'read:user',
  'read:repository',
  'write:repository',
  'write:issue',
  'read:organization',
] as const;
const GITEA_OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export type GiteaOAuthConnectionStatus = 'active' | 'reauthorization_required';

export type GiteaOAuthConnection = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  status: GiteaOAuthConnectionStatus;
};

type GiteaOAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type GiteaOAuthErrorResponse = {
  error?: string;
};

let refreshPromise: Promise<string | null> | null = null;
let deletionPromise: Promise<void> | null = null;
let connectionGeneration = 0;
let cachedAccessToken: string | null = null;

function tokenEndpoint(baseUrl: string): string {
  return new URL(
    'login/oauth/access_token',
    `${baseUrl.replace(/\/$/, '')}/`,
  ).toString();
}

export function getGiteaOAuthScopes(): readonly string[] {
  return DEFAULT_SCOPES;
}

export function buildGiteaOAuthRedirectUri(appUrl: string): string {
  return new URL(
    '/api/source-control/gitea/oauth/callback',
    `${appUrl.replace(/\/$/, '')}/`,
  ).toString();
}

export function createGiteaOAuthAuthorizationUrl(input: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes?: readonly string[];
}): { url: string; state: string } {
  const state = input.state ?? randomBytes(32).toString('hex');
  const url = new URL(
    'login/oauth/authorize',
    `${input.baseUrl.replace(/\/$/, '')}/`,
  );
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', (input.scopes ?? DEFAULT_SCOPES).join(' '));
  return { url: url.toString(), state };
}

async function readConnection(): Promise<GiteaOAuthConnection | null> {
  const row = await db.query.deploymentSecrets?.findFirst?.({
    where: eq(deploymentSecrets.name, SECRET_NAME),
  });
  return row ? await decryptSecrets<GiteaOAuthConnection>(row.value) : null;
}

async function writeConnection(
  connection: GiteaOAuthConnection,
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

export async function getGiteaOAuthConnection(): Promise<GiteaOAuthConnection | null> {
  return readConnection();
}

export async function deleteGiteaOAuthConnection(): Promise<void> {
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

export async function exchangeGiteaOAuthCode(input: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<GiteaOAuthConnection> {
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
  if (!response.ok) {
    throw new Error(
      `Gitea OAuth token exchange failed: ${response.status} ${response.statusText}`,
    );
  }
  const token = (await response.json()) as GiteaOAuthTokenResponse;
  if (!token.access_token || !token.refresh_token) {
    throw new Error('Gitea OAuth did not return an access and refresh token.');
  }

  const connection: GiteaOAuthConnection = {
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    accountId: '',
    username: '',
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(
      Date.now() + (token.expires_in ?? 3600) * 1000,
    ).toISOString(),
    scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [...DEFAULT_SCOPES],
    status: 'active',
  };
  const userResponse = await (input.fetchImpl ?? fetch)(
    new URL('api/v1/user', `${input.baseUrl.replace(/\/$/, '')}/`),
    { headers: { Authorization: `Bearer ${connection.accessToken}` } },
  );
  if (userResponse.ok) {
    const user = (await userResponse.json()) as { id?: number; login?: string };
    connection.accountId = user.id === undefined ? '' : String(user.id);
    connection.username = user.login ?? '';
  }
  await writeConnection(connection);
  cachedAccessToken = connection.accessToken;
  return connection;
}

export async function resolveGiteaOAuthAccessToken(options?: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  requestTimeoutMs?: number;
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
          options?.requestTimeoutMs ?? GITEA_OAUTH_REQUEST_TIMEOUT_MS,
        ),
      },
    );
    if (!response.ok) {
      if (generation !== connectionGeneration) return null;

      const oauthError = await response
        .clone()
        .json()
        .then((body) => (body as GiteaOAuthErrorResponse).error)
        .catch(() => undefined);

      if (oauthError === 'invalid_grant') {
        await writeConnection({
          ...connection,
          status: 'reauthorization_required',
        });
        throw new Error(
          'Gitea OAuth authorization has expired and must be renewed.',
        );
      }

      throw new Error(
        `Gitea OAuth refresh failed: ${response.status} ${response.statusText}`,
      );
    }
    const token = (await response.json()) as GiteaOAuthTokenResponse;
    if (!token.access_token)
      throw new Error('Gitea OAuth refresh did not return an access token.');
    const next = {
      ...connection,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? connection.refreshToken,
      expiresAt: new Date(
        Date.now() + (token.expires_in ?? 3600) * 1000,
      ).toISOString(),
      scopes: token.scope?.split(/\s+/).filter(Boolean) ?? connection.scopes,
      status: 'active' as const,
    };
    if (generation !== connectionGeneration) return null;
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

export function isGiteaOAuthAccessToken(token: string): boolean {
  return token === cachedAccessToken;
}
