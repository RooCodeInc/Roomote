import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JWK, JWTPayload } from 'jose';

const BOT_FRAMEWORK_OPENID_METADATA_URL =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BOT_FRAMEWORK_EXPECTED_ISSUER = 'https://api.botframework.com';
const BOT_FRAMEWORK_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const BOT_FRAMEWORK_CLOCK_TOLERANCE_SECONDS = 5 * 60;

type FetchJson = (input: string | URL, init?: RequestInit) => Promise<Response>;

type CachedValue<T> = {
  expiresAtMs: number;
  value: T;
};

type BotFrameworkOpenIdMetadata = {
  issuer: string;
  jwksUri: string;
};

type BotFrameworkJwk = JWK & {
  endorsements?: string[];
  kid?: string;
  x5t?: string;
};

type BotFrameworkJwks = {
  keys: BotFrameworkJwk[];
};

type VerifyBotFrameworkJwtInput = {
  authorizationHeader: string | undefined;
  botAppId: string;
  activityServiceUrl: string | undefined;
  activityChannelId: string | undefined;
  metadataUrl?: string;
  fetchImpl?: FetchJson;
};

type VerifyBotFrameworkJwtResult = {
  payload: JWTPayload;
};

const openIdMetadataCache = new Map<
  string,
  CachedValue<BotFrameworkOpenIdMetadata>
>();
const jwksCache = new Map<string, CachedValue<BotFrameworkJwks>>();

function getCached<T>(
  cache: Map<string, CachedValue<T>>,
  key: string,
): T | null {
  const cached = cache.get(key);

  if (!cached || cached.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

function setCached<T>(
  cache: Map<string, CachedValue<T>>,
  key: string,
  value: T,
): void {
  cache.set(key, {
    value,
    expiresAtMs: Date.now() + BOT_FRAMEWORK_JWKS_CACHE_TTL_MS,
  });
}

function parseBearerToken(authorizationHeader: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader?.trim() ?? '');

  if (!match?.[1]) {
    throw new Error('Teams Bot Framework authorization must use Bearer JWT.');
  }

  return match[1];
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bot Framework OpenID response was not an object.');
  }

  return value as Record<string, unknown>;
}

function parseOpenIdMetadata(value: unknown): BotFrameworkOpenIdMetadata {
  const object = asObject(value);
  const issuer = object.issuer;
  const jwksUri = object.jwks_uri;

  if (typeof issuer !== 'string' || typeof jwksUri !== 'string') {
    throw new Error(
      'Bot Framework OpenID metadata is missing issuer/jwks_uri.',
    );
  }

  return { issuer, jwksUri };
}

function parseJwks(value: unknown): BotFrameworkJwks {
  const object = asObject(value);
  const keys = object.keys;

  if (!Array.isArray(keys)) {
    throw new Error('Bot Framework JWKS response is missing keys.');
  }

  return {
    keys: keys.map((key) => asObject(key) as BotFrameworkJwk),
  };
}

async function fetchJson(url: string, fetchImpl: FetchJson): Promise<unknown> {
  const response = await fetchImpl(url);

  if (!response.ok) {
    throw new Error(
      `Bot Framework OpenID request failed with HTTP ${response.status}.`,
    );
  }

  return response.json() as Promise<unknown>;
}

async function getOpenIdMetadata(
  metadataUrl: string,
  fetchImpl: FetchJson,
): Promise<BotFrameworkOpenIdMetadata> {
  const cached = getCached(openIdMetadataCache, metadataUrl);

  if (cached) {
    return cached;
  }

  const metadata = parseOpenIdMetadata(await fetchJson(metadataUrl, fetchImpl));
  setCached(openIdMetadataCache, metadataUrl, metadata);

  return metadata;
}

async function getJwks(
  jwksUri: string,
  fetchImpl: FetchJson,
): Promise<BotFrameworkJwks> {
  const cached = getCached(jwksCache, jwksUri);

  if (cached) {
    return cached;
  }

  const jwks = parseJwks(await fetchJson(jwksUri, fetchImpl));
  setCached(jwksCache, jwksUri, jwks);

  return jwks;
}

function findJwtKey(
  jwks: BotFrameworkJwks,
  header: { kid?: string; x5t?: string },
): BotFrameworkJwk | null {
  return (
    jwks.keys.find(
      (key) =>
        (header.kid && key.kid === header.kid) ||
        (header.x5t && key.x5t === header.x5t),
    ) ?? null
  );
}

function verifyServiceUrlClaim(
  payload: JWTPayload,
  activityServiceUrl: string | undefined,
): void {
  if (!activityServiceUrl) {
    throw new Error(
      'Teams Bot Framework JWT verification requires an activity serviceUrl.',
    );
  }

  const serviceUrlClaim =
    typeof payload.serviceurl === 'string'
      ? payload.serviceurl
      : typeof payload.serviceUrl === 'string'
        ? payload.serviceUrl
        : undefined;

  if (serviceUrlClaim !== activityServiceUrl) {
    throw new Error('Teams Bot Framework JWT serviceUrl claim mismatch.');
  }
}

function verifyJwkEndorsement(input: {
  selectedKey: BotFrameworkJwk | null;
  activityChannelId: string | undefined;
}): void {
  if (!input.activityChannelId) {
    return;
  }

  const endorsements = input.selectedKey?.endorsements;

  if (endorsements && !endorsements.includes(input.activityChannelId)) {
    throw new Error(
      'Teams Bot Framework JWT key is not endorsed for this channel.',
    );
  }
}

export async function verifyBotFrameworkJwt({
  authorizationHeader,
  botAppId,
  activityServiceUrl,
  activityChannelId,
  metadataUrl = BOT_FRAMEWORK_OPENID_METADATA_URL,
  fetchImpl = fetch,
}: VerifyBotFrameworkJwtInput): Promise<VerifyBotFrameworkJwtResult> {
  const token = parseBearerToken(authorizationHeader);
  const metadata = await getOpenIdMetadata(metadataUrl, fetchImpl);

  if (metadata.issuer !== BOT_FRAMEWORK_EXPECTED_ISSUER) {
    throw new Error('Teams Bot Framework OpenID issuer mismatch.');
  }

  const jwks = await getJwks(metadata.jwksUri, fetchImpl);
  const verification = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: BOT_FRAMEWORK_EXPECTED_ISSUER,
    audience: botAppId,
    algorithms: ['RS256'],
    clockTolerance: BOT_FRAMEWORK_CLOCK_TOLERANCE_SECONDS,
  });
  const selectedKey = findJwtKey(jwks, {
    kid:
      typeof verification.protectedHeader.kid === 'string'
        ? verification.protectedHeader.kid
        : undefined,
    x5t:
      typeof verification.protectedHeader.x5t === 'string'
        ? verification.protectedHeader.x5t
        : undefined,
  });

  verifyServiceUrlClaim(verification.payload, activityServiceUrl);
  verifyJwkEndorsement({ selectedKey, activityChannelId });

  return { payload: verification.payload };
}
