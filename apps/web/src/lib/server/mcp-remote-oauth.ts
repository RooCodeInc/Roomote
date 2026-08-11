import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

const CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const CLIENT_KEY_PREFIX = 'mcp-remote-oauth:client:';
const CODE_KEY_PREFIX = 'mcp-remote-oauth:code:';

export type RemoteMcpOAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
};

export type RemoteMcpAuthorizationCode = {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
};

function clientKey(clientId: string): string {
  return `${CLIENT_KEY_PREFIX}${clientId}`;
}

function codeKey(code: string): string {
  return `${CODE_KEY_PREFIX}${code}`;
}

export function isAllowedOAuthRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hash === '' &&
      url.username === '' &&
      url.password === '' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          (url.hostname === '127.0.0.1' || url.hostname === 'localhost')))
    );
  } catch {
    return false;
  }
}

export async function registerRemoteMcpOAuthClient(input: {
  clientName?: string;
  redirectUris: string[];
}): Promise<RemoteMcpOAuthClient> {
  const client: RemoteMcpOAuthClient = {
    clientId: randomUUID(),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    redirectUris: input.redirectUris,
  };

  await getRedis().set(
    clientKey(client.clientId),
    JSON.stringify(client),
    'EX',
    CLIENT_TTL_SECONDS,
  );
  return client;
}

export async function getRemoteMcpOAuthClient(
  clientId: string,
): Promise<RemoteMcpOAuthClient | null> {
  const value = await getRedis().get(clientKey(clientId));
  return value ? (JSON.parse(value) as RemoteMcpOAuthClient) : null;
}

export async function createRemoteMcpAuthorizationCode(
  value: RemoteMcpAuthorizationCode,
): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await getRedis().set(
    codeKey(code),
    JSON.stringify(value),
    'EX',
    AUTHORIZATION_CODE_TTL_SECONDS,
    'NX',
  );
  return code;
}

export async function consumeRemoteMcpAuthorizationCode(
  code: string,
): Promise<RemoteMcpAuthorizationCode | null> {
  const value = await getRedis().getdel(codeKey(code));
  return value ? (JSON.parse(value) as RemoteMcpAuthorizationCode) : null;
}

export function verifyPkceChallenge(
  verifier: string,
  expectedChallenge: string,
): boolean {
  return (
    createHash('sha256').update(verifier).digest('base64url') ===
    expectedChallenge
  );
}
