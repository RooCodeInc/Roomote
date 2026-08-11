import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

const PENDING_CLIENT_TTL_SECONDS = 60 * 60;
const ACTIVE_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const CONSENT_TOKEN_TTL_SECONDS = 10 * 60;
const REGISTRATION_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const REGISTRATION_RATE_LIMIT_PER_CLIENT = 20;
const REGISTRATION_RATE_LIMIT_GLOBAL = 100;
const MAX_REGISTERED_CLIENTS = 250;
const MAX_ACTIVE_CLIENTS_PER_USER = 50;
const MAX_ACTIVE_CLIENTS_GLOBAL = 10_000;
const CLIENT_KEY_PREFIX = 'mcp-remote-oauth:client:';
const CODE_KEY_PREFIX = 'mcp-remote-oauth:code:';
const CONSENT_KEY_PREFIX = 'mcp-remote-oauth:consent:';
const REGISTRATION_RATE_KEY_PREFIX = 'mcp-remote-oauth:registration-rate:';
const REGISTERED_CLIENTS_KEY = 'mcp-remote-oauth:registered-clients';
const ACTIVE_CLIENTS_KEY = 'mcp-remote-oauth:active-clients';
const ACTIVE_CLIENTS_USER_KEY_PREFIX = 'mcp-remote-oauth:active-clients:user:';

const CONSUME_CODE_LUA = `
local value = redis.call('GET', KEYS[1])
if value == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return value
end
return false
`;

const ADMIT_REGISTRATION_LUA = `
local client = tonumber(redis.call('GET', KEYS[1]) or '0')
local global = tonumber(redis.call('GET', KEYS[2]) or '0')
if client >= tonumber(ARGV[2]) or global >= tonumber(ARGV[3]) then
  return 0
end
client = redis.call('INCR', KEYS[1])
global = redis.call('INCR', KEYS[2])
if client == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if global == 1 then
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
return 1
`;

const REGISTER_CLIENT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[6])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
`;

const PROMOTE_CLIENT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[3])
local globalMember = redis.call('ZSCORE', KEYS[3], ARGV[2])
local userMember = redis.call('ZSCORE', KEYS[4], ARGV[2])
if not globalMember and redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[5]) then
  return 0
end
if not userMember and redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[6]) then
  return 0
end
if redis.call('EXPIRE', KEYS[1], ARGV[1]) == 0 then
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
redis.call('EXPIRE', KEYS[4], ARGV[1])
return 1
`;

type RemoteMcpOAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
};

type RemoteMcpAuthorizationCode = {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
};

type RemoteMcpConsentBinding = {
  userId: string;
  requestTarget: string;
};

function clientKey(clientId: string): string {
  return `${CLIENT_KEY_PREFIX}${clientId}`;
}

function codeKey(code: string): string {
  return `${CODE_KEY_PREFIX}${code}`;
}

function consentKey(token: string): string {
  return `${CONSENT_KEY_PREFIX}${token}`;
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

  const now = Math.floor(Date.now() / 1000);
  const stored = await getRedis().eval(
    REGISTER_CLIENT_LUA,
    2,
    clientKey(client.clientId),
    REGISTERED_CLIENTS_KEY,
    JSON.stringify(client),
    String(PENDING_CLIENT_TTL_SECONDS),
    String(now + PENDING_CLIENT_TTL_SECONDS),
    client.clientId,
    String(MAX_REGISTERED_CLIENTS),
    String(now),
  );
  if (stored !== 1) {
    throw new Error('Remote MCP client registration capacity reached');
  }
  return client;
}

export async function promoteRemoteMcpOAuthClient(
  clientId: string,
  userId: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const userHash = createHash('sha256').update(userId).digest('hex');
  const promoted = await getRedis().eval(
    PROMOTE_CLIENT_LUA,
    4,
    clientKey(clientId),
    REGISTERED_CLIENTS_KEY,
    ACTIVE_CLIENTS_KEY,
    `${ACTIVE_CLIENTS_USER_KEY_PREFIX}${userHash}`,
    String(ACTIVE_CLIENT_TTL_SECONDS),
    clientId,
    String(now),
    String(now + ACTIVE_CLIENT_TTL_SECONDS),
    String(MAX_ACTIVE_CLIENTS_GLOBAL),
    String(MAX_ACTIVE_CLIENTS_PER_USER),
  );
  return promoted === 1;
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

export async function createRemoteMcpConsentToken(
  value: RemoteMcpConsentBinding,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await getRedis().set(
    consentKey(token),
    JSON.stringify(value),
    'EX',
    CONSENT_TOKEN_TTL_SECONDS,
    'NX',
  );
  return token;
}

export async function getRemoteMcpAuthorizationCode(
  code: string,
): Promise<RemoteMcpAuthorizationCode | null> {
  const value = await getRedis().get(codeKey(code));
  return value ? (JSON.parse(value) as RemoteMcpAuthorizationCode) : null;
}

export async function consumeRemoteMcpAuthorizationCode(
  code: string,
  expected: RemoteMcpAuthorizationCode,
): Promise<boolean> {
  const value = await getRedis().eval(
    CONSUME_CODE_LUA,
    1,
    codeKey(code),
    JSON.stringify(expected),
  );
  return typeof value === 'string';
}

export async function consumeRemoteMcpConsentToken(
  token: string,
  expected: RemoteMcpConsentBinding,
): Promise<boolean> {
  const value = await getRedis().eval(
    CONSUME_CODE_LUA,
    1,
    consentKey(token),
    JSON.stringify(expected),
  );
  return typeof value === 'string';
}

export async function isRemoteMcpRegistrationAllowed(
  registrationFingerprint: string,
): Promise<boolean> {
  const window = Math.floor(
    Date.now() / (REGISTRATION_RATE_LIMIT_WINDOW_SECONDS * 1000),
  );
  const clientHash = createHash('sha256')
    .update(registrationFingerprint)
    .digest('hex');
  const admitted = await getRedis().eval(
    ADMIT_REGISTRATION_LUA,
    2,
    `${REGISTRATION_RATE_KEY_PREFIX}client:${clientHash}:${window}`,
    `${REGISTRATION_RATE_KEY_PREFIX}global:${window}`,
    String(REGISTRATION_RATE_LIMIT_WINDOW_SECONDS),
    String(REGISTRATION_RATE_LIMIT_PER_CLIENT),
    String(REGISTRATION_RATE_LIMIT_GLOBAL),
  );
  return admitted === 1;
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
