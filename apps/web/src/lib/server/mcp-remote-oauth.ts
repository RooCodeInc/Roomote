import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

const PENDING_CLIENT_TTL_SECONDS = 60 * 60;
const ACTIVE_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_SESSION_TTL_SECONDS = ACTIVE_CLIENT_TTL_SECONDS;
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
const REFRESH_SESSION_KEY_PREFIX = 'mcp-remote-oauth:session:';
const REFRESH_TOKEN_KEY_PREFIX = 'mcp-remote-oauth:refresh:';

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

const CREATE_REFRESH_SESSION_LUA = `
local previous = redis.call('GET', KEYS[1])
if previous then
  local decoded = cjson.decode(previous)
  redis.call('DEL', ARGV[1] .. decoded.currentTokenHash)
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return 1
`;

const ROTATE_REFRESH_TOKEN_LUA = `
local marker = redis.call('GET', KEYS[1])
if marker == ARGV[1] then
  local session = redis.call('GET', KEYS[3])
  if session then
    local decoded = cjson.decode(session)
    redis.call('DEL', ARGV[5] .. decoded.currentTokenHash)
  end
  redis.call('DEL', KEYS[3])
  return {'reuse'}
end
if marker ~= ARGV[2] then
  return {'invalid'}
end
local session = redis.call('GET', KEYS[3])
if not session or session ~= ARGV[3] then
  return {'invalid'}
end
redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL')
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[6])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[6])
return {'ok'}
`;

const REVOKE_REFRESH_SESSION_LUA = `
local marker = redis.call('GET', KEYS[1])
if marker ~= ARGV[3] then
  return 0
end
local session = redis.call('GET', KEYS[2])
if not session then
  return 0
end
local decoded = cjson.decode(session)
if decoded.clientId ~= ARGV[1] or decoded.currentTokenHash ~= ARGV[4] then
  return 0
end
redis.call('DEL', ARGV[2] .. decoded.currentTokenHash)
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

type RemoteMcpOAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  grantTypes: ('authorization_code' | 'refresh_token')[];
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

type RemoteMcpRefreshSession = {
  sessionId: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  currentTokenHash: string;
  expiresAt: number;
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

function refreshSessionId(userId: string, clientId: string): string {
  return createHash('sha256').update(`${userId}\0${clientId}`).digest('hex');
}

function refreshSessionKey(sessionId: string): string {
  return `${REFRESH_SESSION_KEY_PREFIX}${sessionId}`;
}

function refreshTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function refreshTokenKey(tokenHash: string): string {
  return `${REFRESH_TOKEN_KEY_PREFIX}${tokenHash}`;
}

function createRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString('base64url')}`;
}

function parseRefreshToken(token: string): string | null {
  const separator = token.indexOf('.');
  const sessionId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  return /^[a-f0-9]{64}$/.test(sessionId) && secret.length >= 32
    ? sessionId
    : null;
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
  grantTypes?: ('authorization_code' | 'refresh_token')[];
}): Promise<RemoteMcpOAuthClient> {
  const client: RemoteMcpOAuthClient = {
    clientId: randomUUID(),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes ?? ['authorization_code'],
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
  if (!value) return null;
  const client = JSON.parse(value) as Omit<
    RemoteMcpOAuthClient,
    'grantTypes'
  > & {
    grantTypes?: RemoteMcpOAuthClient['grantTypes'];
  };
  return {
    ...client,
    grantTypes: client.grantTypes ?? ['authorization_code'],
  };
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

export async function createRemoteMcpRefreshSession(value: {
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
}): Promise<string> {
  const sessionId = refreshSessionId(value.userId, value.clientId);
  const refreshToken = createRefreshToken(sessionId);
  const tokenHash = refreshTokenHash(refreshToken);
  const now = Math.floor(Date.now() / 1000);
  const session: RemoteMcpRefreshSession = {
    sessionId,
    ...value,
    currentTokenHash: tokenHash,
    expiresAt: now + REFRESH_SESSION_TTL_SECONDS,
  };
  await getRedis().eval(
    CREATE_REFRESH_SESSION_LUA,
    2,
    refreshSessionKey(sessionId),
    refreshTokenKey(tokenHash),
    REFRESH_TOKEN_KEY_PREFIX,
    JSON.stringify(session),
    `active:${sessionId}`,
    String(REFRESH_SESSION_TTL_SECONDS),
  );
  return refreshToken;
}

export async function getRemoteMcpRefreshSession(
  refreshToken: string,
): Promise<RemoteMcpRefreshSession | null> {
  const sessionId = parseRefreshToken(refreshToken);
  if (!sessionId) return null;
  const tokenHash = refreshTokenHash(refreshToken);
  const redis = getRedis();
  const [marker, value] = await Promise.all([
    redis.get(refreshTokenKey(tokenHash)),
    redis.get(refreshSessionKey(sessionId)),
  ]);
  if (marker !== `active:${sessionId}` || !value) return null;
  const session = JSON.parse(value) as RemoteMcpRefreshSession;
  return session.currentTokenHash === tokenHash ? session : null;
}

export async function rotateRemoteMcpRefreshToken(
  refreshToken: string,
  expected: RemoteMcpRefreshSession,
): Promise<
  { status: 'ok'; refreshToken: string } | { status: 'invalid' | 'reuse' }
> {
  const sessionId = parseRefreshToken(refreshToken);
  if (!sessionId || sessionId !== expected.sessionId) {
    return { status: 'invalid' };
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = expected.expiresAt - now;
  if (ttl <= 0) return { status: 'invalid' };

  const nextRefreshToken = createRefreshToken(sessionId);
  const nextTokenHash = refreshTokenHash(nextRefreshToken);
  const nextSession = { ...expected, currentTokenHash: nextTokenHash };
  const oldTokenHash = refreshTokenHash(refreshToken);
  const result = (await getRedis().eval(
    ROTATE_REFRESH_TOKEN_LUA,
    3,
    refreshTokenKey(oldTokenHash),
    refreshTokenKey(nextTokenHash),
    refreshSessionKey(sessionId),
    `rotated:${sessionId}`,
    `active:${sessionId}`,
    JSON.stringify(expected),
    JSON.stringify(nextSession),
    REFRESH_TOKEN_KEY_PREFIX,
    String(ttl),
  )) as string[];
  if (result[0] !== 'ok') {
    return { status: result[0] === 'reuse' ? 'reuse' : 'invalid' };
  }
  return { status: 'ok', refreshToken: nextRefreshToken };
}

export async function revokeRemoteMcpRefreshSession(
  refreshToken: string,
  clientId: string,
): Promise<void> {
  const sessionId = parseRefreshToken(refreshToken);
  if (!sessionId) return;
  const tokenHash = refreshTokenHash(refreshToken);
  await getRedis().eval(
    REVOKE_REFRESH_SESSION_LUA,
    2,
    refreshTokenKey(tokenHash),
    refreshSessionKey(sessionId),
    clientId,
    REFRESH_TOKEN_KEY_PREFIX,
    `active:${sessionId}`,
    tokenHash,
  );
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
