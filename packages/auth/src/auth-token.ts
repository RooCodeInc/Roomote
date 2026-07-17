import jwt from 'jsonwebtoken';
import { z } from 'zod';

import {
  type AuthTokenPayload,
  type AuthTokenContext,
  authTokenPayloadSchema,
} from '@roomote/types';

import {
  getJobAuthPrivateKey,
  getJobAuthPublicKey,
  isAuthClientTestEnv,
} from './client-runtime';

const ISSUER = 'rcc';
export const DEFAULT_USER_AUTH_TOKEN_TIMEOUT_MS = 60_000;
export const DEFAULT_AUTH_TOKEN_EXPIRATION_GRACE_PERIOD_MS = 5 * 60 * 1000;
export const PUBLIC_USER_AUTH_TOKEN_EXPIRATION_GRACE_PERIOD_MS = 0;
/** Cap for caller-supplied public auth-token TTLs (1 hour). */
const MAX_PUBLIC_USER_AUTH_TOKEN_TIMEOUT_MS = 60 * 60 * 1000;
export const publicAuthTokenTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_PUBLIC_USER_AUTH_TOKEN_TIMEOUT_MS);

export const createAuthTokenOptionsSchema = z.object({
  userId: z.string(),
  timeoutMs: z.number(),
  expirationGracePeriodMs: z.number().int().nonnegative().optional(),
});

export type CreateAuthTokenOptions = z.infer<
  typeof createAuthTokenOptionsSchema
>;

export async function createAuthToken({
  userId,
  timeoutMs,
  expirationGracePeriodMs,
}: CreateAuthTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const gracePeriod = Math.floor(
    (expirationGracePeriodMs ?? DEFAULT_AUTH_TOKEN_EXPIRATION_GRACE_PERIOD_MS) /
      1000,
  );
  const clockSkewGrace = 30; // 30 seconds

  const payload: AuthTokenPayload = {
    iss: ISSUER,
    sub: userId,
    exp: now + Math.floor(timeoutMs / 1000) + gracePeriod,
    iat: now,
    nbf: now - clockSkewGrace,
    v: 1,
    r: {
      u: userId,
      t: 'auth',
    },
  };

  const privateKey = Buffer.from(getJobAuthPrivateKey(), 'base64').toString(
    'utf-8',
  );

  return jwt.sign(payload, privateKey, { algorithm: 'ES256' });
}

export async function createPublicAuthToken(options: {
  userId: string;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs =
    options.timeoutMs === undefined
      ? DEFAULT_USER_AUTH_TOKEN_TIMEOUT_MS
      : publicAuthTokenTimeoutMsSchema.parse(options.timeoutMs);

  return createAuthToken({
    userId: options.userId,
    timeoutMs,
    expirationGracePeriodMs: PUBLIC_USER_AUTH_TOKEN_EXPIRATION_GRACE_PERIOD_MS,
  });
}

export async function validateAuthToken(
  token: string,
): Promise<AuthTokenContext> {
  const publicKey = Buffer.from(getJobAuthPublicKey(), 'base64').toString(
    'utf-8',
  );

  const rawPayload = jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    clockTolerance: 60,
    ignoreNotBefore: isAuthClientTestEnv(),
    issuer: ISSUER,
  });

  const parseResult = authTokenPayloadSchema.safeParse(rawPayload);

  if (!parseResult.success) {
    const validationErrors = parseResult.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');

    throw new Error(`Invalid auth token structure: ${validationErrors}`);
  }

  const payload = parseResult.data;

  const {
    r: { u: userId, t: tokenType },
    v: version,
  } = payload;

  return { userId, tokenType, version };
}
