import { createHash, randomBytes } from 'node:crypto';

import { getMcpOAuthRedis as getRedis } from './client';

// A new namespace intentionally excludes legacy, untracked authorizations.
const PREFIX = 'mcp-remote-oauth:grants:v2:';
const CODE_TTL = 300;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const USER_LIMIT = 50;
const GLOBAL_LIMIT = 10_000;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const grantKey = (id: string) => `${PREFIX}grant:${id}`;
const userKey = (id: string) => `${PREFIX}user:${hash(id)}`;
const pairKey = (userId: string, clientId: string) =>
  `${PREFIX}pair:${hash(`${userId}\0${clientId}`)}`;
const legacyUserKey = (userId: string) =>
  `mcp-remote-oauth:active-clients:user:${hash(userId)}`;
const legacyPairKey = (userId: string, clientId: string) =>
  `mcp-remote-oauth:client-session:${hash(`${userId}\0${clientId}`)}`;
const codeKey = (code: string) => `${PREFIX}code:${hash(code)}`;
const tokenKey = (token: string) => `${PREFIX}token:${hash(token)}`;
const secret = () => randomBytes(32).toString('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);

interface McpOAuthAuthorization {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
}

interface Grant extends McpOAuthAuthorization {
  grantId: string;
  clientName: string;
  authorizedAt: number | null;
  expiresAt: number;
  lastUsedAt: number | null;
  lastTokenAt: number | null;
  status: 'pending' | 'active';
  codeKey?: string;
  currentTokenKey?: string;
}

export type McpOAuthGrantSummary = Pick<
  Grant,
  | 'grantId'
  | 'userId'
  | 'clientName'
  | 'authorizedAt'
  | 'expiresAt'
  | 'lastUsedAt'
  | 'lastTokenAt'
  | 'status'
>;

// Every operation that can admit a credential and every revocation is one Redis
// transaction. Never re-create a grant from a code/session read outside Lua.
const COMMON = `
local prefix = ARGV[1]
local now = tonumber(ARGV[2])
local function read(id)
  local raw = redis.call('GET', prefix .. 'grant:' .. id)
  if not raw then return nil end
  local g = cjson.decode(raw)
  if g.expiresAt <= now then return nil end
  return g
end
local function removeLegacy(pair, userId)
  local id = redis.call('GET', pair)
  if not id then return end
  local key = 'mcp-remote-oauth:session:' .. id
  local raw = redis.call('GET', key)
  if raw then
    local old = cjson.decode(raw)
    if old.userId ~= userId then return end
    redis.call('DEL', 'mcp-remote-oauth:refresh:' .. old.currentTokenHash, key)
  end
  redis.call('DEL', pair)
end
local function remove(id)
  local key = prefix .. 'grant:' .. id
  local raw = redis.call('GET', key)
  if raw then
    local g = cjson.decode(raw)
    redis.call('SET', g.pairKey .. ':legacy-blocked', '1', 'EX', ${31 * 24 * 3600})
    if g.codeKey then redis.call('DEL', g.codeKey) end
    if g.currentTokenKey then redis.call('DEL', g.currentTokenKey) end
    if redis.call('GET', g.pairKey) == id then redis.call('DEL', g.pairKey) end
    redis.call('ZREM', g.userKey, id)
    removeLegacy(g.legacyPairKey, g.userId)
    redis.call('ZREM', g.legacyUserKey, g.clientId)
  end
  redis.call('DEL', key)
  redis.call('ZREM', prefix .. 'all', id)
end
local function save(g)
  local ttl = g.expiresAt - now
  redis.call('SET', prefix .. 'grant:' .. g.grantId, cjson.encode(g), 'EX', ttl)
  redis.call('SET', g.pairKey, g.grantId, 'EX', ttl)
  redis.call('ZADD', g.userKey, g.expiresAt, g.grantId)
  redis.call('EXPIRE', g.userKey, ${REFRESH_TTL})
  redis.call('ZADD', prefix .. 'all', g.expiresAt, g.grantId)
end
`;

const CREATE = `${COMMON}
local g = cjson.decode(ARGV[3])
local previous = redis.call('GET', g.pairKey)
redis.call('ZREMRANGEBYSCORE', g.userKey, '-inf', now)
redis.call('ZREMRANGEBYSCORE', prefix .. 'all', '-inf', now)
local allowance = 0
if previous and read(previous) then allowance = 1 end
if redis.call('ZCARD', g.userKey) - allowance >= ${USER_LIMIT} or
   redis.call('ZCARD', prefix .. 'all') - allowance >= ${GLOBAL_LIMIT} then return 0 end
if previous then remove(previous) end
removeLegacy(g.legacyPairKey, g.userId)
redis.call('SET', g.pairKey .. ':legacy-blocked', '1', 'EX', ${31 * 24 * 3600})
save(g)
redis.call('SET', g.codeKey, g.grantId, 'EX', ${CODE_TTL})
return 1
`;

const EXCHANGE = `${COMMON}
local g = read(ARGV[3])
if not g or g.status ~= 'pending' or g.codeKey ~= KEYS[1] or
   redis.call('GET', KEYS[1]) ~= g.grantId then return 0 end
redis.call('DEL', KEYS[1])
g.codeKey = nil
g.status = 'active'
g.lastTokenAt = now
g.expiresAt = now + tonumber(ARGV[4])
if ARGV[5] ~= '' then
  g.currentTokenKey = ARGV[5]
  redis.call('SET', g.currentTokenKey, 'active:' .. g.grantId, 'EX', ARGV[4])
end
save(g)
return 1
`;

const ROTATE = `${COMMON}
local g = read(ARGV[3])
local marker = redis.call('GET', KEYS[1])
if marker == 'rotated:' .. ARGV[3] then
  remove(ARGV[3])
  return 'reuse'
end
if not g or g.status ~= 'active' or g.currentTokenKey ~= KEYS[1] or
   marker ~= 'active:' .. g.grantId then return 'invalid' end
redis.call('SET', KEYS[1], 'rotated:' .. g.grantId, 'KEEPTTL')
redis.call('SET', KEYS[2], 'active:' .. g.grantId, 'EX', g.expiresAt - now)
g.currentTokenKey = KEYS[2]
g.lastTokenAt = now
save(g)
return 'ok'
`;

function parseToken(token: string): string | null {
  const [id, value, extra] = token.split('.');
  return id &&
    value &&
    !extra &&
    /^[a-f0-9]{64}$/.test(id) &&
    /^[A-Za-z0-9_-]{32,128}$/.test(value)
    ? id
    : null;
}

// Existing sessions are self-describing; access JWTs are not. Destructively
// adopt a live refresh family once, preserving its absolute remaining lifetime.
// Listing and refresh use this same atomic operation, never SCAN or SQL.
async function migrateLegacySession(
  sessionId: string,
  userId?: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return;
  const raw = await getRedis().get(`mcp-remote-oauth:session:${sessionId}`);
  if (!raw) return;
  const legacy = JSON.parse(raw) as {
    userId: string;
    clientId: string;
    resource: string;
    scopes: string[];
    currentTokenHash: string;
    expiresAt: number;
  };
  if (userId && legacy.userId !== userId) return;
  const clientRaw = await getRedis().get(
    `mcp-remote-oauth:client:${legacy.clientId}`,
  );
  const client = clientRaw
    ? (JSON.parse(clientRaw) as { clientName?: string })
    : null;
  const now = nowSeconds();
  const grant = {
    ...legacy,
    grantId: sessionId,
    clientName: safeClientName(client?.clientName),
    // Legacy storage has no authorization/activity times. Do not invent them.
    authorizedAt: null,
    lastUsedAt: null,
    lastTokenAt: null,
    status: 'active',
    redirectUri: '',
    codeChallenge: '',
    userKey: userKey(legacy.userId),
    pairKey: pairKey(legacy.userId, legacy.clientId),
    legacyPairKey: legacyPairKey(legacy.userId, legacy.clientId),
    legacyUserKey: legacyUserKey(legacy.userId),
    currentTokenKey: `${PREFIX}token:${legacy.currentTokenHash}`,
  };
  await getRedis().eval(
    `${COMMON}
local g = cjson.decode(ARGV[3])
local legacyKey = 'mcp-remote-oauth:session:' .. g.grantId
if redis.call('GET', legacyKey) ~= ARGV[4] then return 0 end
local ttl = redis.call('TTL', legacyKey)
if ttl <= 0 or g.expiresAt <= now then return 0 end
local legacyTokenKey = 'mcp-remote-oauth:refresh:' .. g.currentTokenHash
if redis.call('GET', legacyTokenKey) ~= 'active:' .. g.grantId then return 0 end
local oldPair = ARGV[5]
if redis.call('EXISTS', g.userKey .. ':legacy-blocked') == 1 or
   redis.call('EXISTS', g.pairKey .. ':legacy-blocked') == 1 or
   redis.call('EXISTS', g.pairKey) == 1 then
  redis.call('DEL', legacyKey, legacyTokenKey)
  if redis.call('GET', oldPair) == g.grantId then redis.call('DEL', oldPair) end
  return 0
end
redis.call('ZREMRANGEBYSCORE', g.userKey, '-inf', now)
redis.call('ZREMRANGEBYSCORE', prefix .. 'all', '-inf', now)
if redis.call('ZCARD', g.userKey) >= ${USER_LIMIT} or
   redis.call('ZCARD', prefix .. 'all') >= ${GLOBAL_LIMIT} then return 0 end
g.expiresAt = math.min(g.expiresAt, now + ttl)
redis.call('SET', g.currentTokenKey, 'active:' .. g.grantId, 'EX', g.expiresAt - now)
g.currentTokenHash = nil
save(g)
redis.call('DEL', legacyKey, legacyTokenKey)
if redis.call('GET', oldPair) == g.grantId then redis.call('DEL', oldPair) end
return 1`,
    0,
    PREFIX,
    now,
    JSON.stringify(grant),
    raw,
    legacyPairKey(legacy.userId, legacy.clientId),
  );
}

function safeClientName(name?: string): string {
  return (
    name
      ?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, 200) || 'Unnamed MCP client'
  );
}

export async function createMcpOAuthCode(
  authorization: McpOAuthAuthorization,
  clientName?: string,
): Promise<string> {
  const code = secret();
  const now = nowSeconds();
  const grant = {
    ...authorization,
    grantId: secret(),
    // Client-supplied text is display-only; never return callback URLs/secrets.
    clientName: safeClientName(clientName),
    authorizedAt: now,
    expiresAt: now + CODE_TTL,
    lastUsedAt: null,
    lastTokenAt: null,
    status: 'pending',
    codeKey: codeKey(code),
    userKey: userKey(authorization.userId),
    pairKey: pairKey(authorization.userId, authorization.clientId),
    legacyPairKey: legacyPairKey(authorization.userId, authorization.clientId),
    legacyUserKey: legacyUserKey(authorization.userId),
  };
  const result = await getRedis().eval(
    CREATE,
    0,
    PREFIX,
    now,
    JSON.stringify(grant),
  );
  if (result !== 1) throw new Error('MCP authorization capacity reached');
  return code;
}

async function getGrant(id: string): Promise<Grant | null> {
  const raw = await getRedis().get(grantKey(id));
  if (!raw) return null;
  const grant = JSON.parse(raw) as Grant;
  return grant.expiresAt > nowSeconds() ? grant : null;
}

export async function getMcpOAuthCode(code: string): Promise<Grant | null> {
  const id = await getRedis().get(codeKey(code));
  return id ? getGrant(id) : null;
}

export async function exchangeMcpOAuthCode(
  code: string,
  grant: Grant,
  refresh: boolean,
) {
  const refreshToken = refresh ? `${grant.grantId}.${secret()}` : undefined;
  const result = await getRedis().eval(
    EXCHANGE,
    1,
    codeKey(code),
    PREFIX,
    nowSeconds(),
    grant.grantId,
    refresh ? REFRESH_TTL : ACCESS_TTL,
    refreshToken ? tokenKey(refreshToken) : '',
  );
  return result === 1 ? { refreshToken } : null;
}

export async function getMcpOAuthRefresh(token: string): Promise<Grant | null> {
  const id = parseToken(token);
  if (!id) return null;
  await migrateLegacySession(id);
  const grant = await getGrant(id);
  return grant?.currentTokenKey === tokenKey(token) ? grant : null;
}

export async function rotateMcpOAuthRefresh(token: string, grant: Grant) {
  const refreshToken = `${grant.grantId}.${secret()}`;
  const status = await getRedis().eval(
    ROTATE,
    2,
    tokenKey(token),
    tokenKey(refreshToken),
    PREFIX,
    nowSeconds(),
    grant.grantId,
  );
  return { status, refreshToken };
}

export async function revokeMcpOAuthRefresh(
  token: string,
  clientId?: string,
): Promise<void> {
  const id = parseToken(token);
  if (!id) return;
  await getRedis().eval(
    `${COMMON}
local marker = redis.call('GET', KEYS[1])
local legacyMarker = redis.call('GET', KEYS[2])
local g = read(ARGV[3])
if g and (ARGV[4] == '' or g.clientId == ARGV[4]) and
   (marker == 'rotated:' .. g.grantId or marker == 'active:' .. g.grantId or
    legacyMarker == 'rotated:' .. g.grantId) then
  remove(g.grantId)
end
return 1`,
    2,
    tokenKey(token),
    `mcp-remote-oauth:refresh:${hash(token)}`,
    PREFIX,
    nowSeconds(),
    id,
    clientId ?? '',
  );
}

export async function isMcpOAuthGrantLive(identity: {
  userId: string;
  clientId?: string;
  grantId?: string;
}): Promise<boolean> {
  // Legacy JWTs cannot be targeted safely. Clients must refresh or re-consent.
  if (!identity.clientId || !identity.grantId) return false;
  const result = await getRedis().eval(
    `${COMMON}
local g = read(ARGV[3])
if not g or g.status ~= 'active' or g.userId ~= ARGV[4] or g.clientId ~= ARGV[5] then return 0 end
g.lastUsedAt = now
save(g)
return 1`,
    0,
    PREFIX,
    nowSeconds(),
    identity.grantId,
    identity.userId,
    identity.clientId,
  );
  return result === 1;
}

export async function listMcpOAuthGrants(
  userId: string,
): Promise<McpOAuthGrantSummary[]> {
  const clients = await getRedis().zrange(
    legacyUserKey(userId),
    0,
    USER_LIMIT - 1,
  );
  await Promise.all(
    clients.map(async (clientId) => {
      const id = await getRedis().get(legacyPairKey(userId, clientId));
      if (id) await migrateLegacySession(id, userId);
    }),
  );
  // One bounded atomic snapshot; expired/code-only grants use the same index.
  const rows = (await getRedis().eval(
    `${COMMON}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local rows = {}
for _, id in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local g = read(id)
  if g and g.userId == ARGV[3] then
    table.insert(rows, cjson.encode({grantId=g.grantId, userId=g.userId,
      clientName=g.clientName, authorizedAt=g.authorizedAt, expiresAt=g.expiresAt,
      lastUsedAt=g.lastUsedAt, lastTokenAt=g.lastTokenAt, status=g.status}))
  else
    redis.call('ZREM', KEYS[1], id)
    redis.call('ZREM', prefix .. 'all', id)
  end
end
return rows`,
    1,
    userKey(userId),
    PREFIX,
    nowSeconds(),
    userId,
  )) as string[];
  return rows.map((row) => JSON.parse(row) as McpOAuthGrantSummary);
}

/** Authorization of the target user belongs to the authenticated caller. */
export async function revokeMcpOAuthGrants(
  userId: string,
  grantId?: string,
): Promise<void> {
  const legacyPairs = grantId
    ? []
    : (await getRedis().zrange(legacyUserKey(userId), 0, USER_LIMIT - 1)).map(
        (id) => legacyPairKey(userId, id),
      );
  await getRedis().eval(
    `${COMMON}
if ARGV[4] ~= '' then
  local g = read(ARGV[4])
  if g and g.userId == ARGV[3] then remove(g.grantId) end
else
  redis.call('SET', KEYS[1] .. ':legacy-blocked', '1', 'EX', ${31 * 24 * 3600})
  for _, pair in ipairs(cjson.decode(ARGV[5])) do removeLegacy(pair, ARGV[3]) end
  redis.call('DEL', KEYS[2])
  for _, id in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
    local g = read(id)
    if g and g.userId == ARGV[3] then remove(id) end
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
end
return 1`,
    2,
    userKey(userId),
    legacyUserKey(userId),
    PREFIX,
    nowSeconds(),
    userId,
    grantId ?? '',
    JSON.stringify(legacyPairs),
  );
}
