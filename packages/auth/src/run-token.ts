import jwt from 'jsonwebtoken';
import { z } from 'zod';

import {
  type RunTokenPayload,
  type RunTokenContext,
  runTokenPayloadSchema,
} from '@roomote/types';

import {
  getJobAuthPrivateKey,
  getJobAuthPublicKey,
  isAuthClientTestEnv,
} from './client-runtime';
import {
  decodeEs256PrivateKeyPem,
  decodeEs256PublicKeyPem,
} from './decode-es256-key';

const ISSUER = 'rcc';

/** Cap for run-token TTLs that aligns with SANDBOX_TIMEOUT_MS (5 hours). */
export const MAX_RUN_TOKEN_TIMEOUT_MS = 5 * 60 * 60 * 1_000;

export const runTokenTimeoutMsSchema = z
  .number()
  .positive()
  .max(MAX_RUN_TOKEN_TIMEOUT_MS);

// Private rolling-deploy parser for signed tokens minted by the previous
// release. The exported payload contract and every newly minted token remain
// strictly run-based; pre-deploy tokens naturally age out after their TTL.
const compatibleRunTokenPayloadSchema = runTokenPayloadSchema.extend({
  r: runTokenPayloadSchema.shape.r.extend({
    t: z.union([z.literal('run'), z.literal('cj')]),
  }),
});

export const createRunTokenOptionsSchema = z.object({
  runId: z.number(),
  // Null mints a deployment-service-principal token for runs with no human
  // driver (automation-initiated work).
  userId: z.string().nullable(),
  // Align with SANDBOX_TIMEOUT_MS (5h) so a member cannot mint near-eternal
  // sandbox tokens via the public router.
  timeoutMs: runTokenTimeoutMsSchema,
});

export type CreateRunTokenOptions = z.infer<typeof createRunTokenOptionsSchema>;

interface ValidateRunTokenOptions {
  ignoreExpiration?: boolean;
}

export async function createRunToken({
  runId,
  userId,
  timeoutMs,
}: CreateRunTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const gracePeriod = 5 * 60; // 5 minutes
  const clockSkewGrace = 30; // 30 seconds

  const payload: RunTokenPayload = {
    iss: ISSUER,
    sub: runId.toString(),
    exp: now + Math.floor(timeoutMs / 1000) + gracePeriod,
    iat: now,
    nbf: now - clockSkewGrace,
    v: 1,
    r: {
      ...(userId ? { u: userId } : {}),
      t: 'run',
    },
  };

  const privateKey = decodeEs256PrivateKeyPem(
    getJobAuthPrivateKey(),
    'JOB_AUTH_PRIVATE_KEY',
  );

  return jwt.sign(payload, privateKey, { algorithm: 'ES256' });
}

export async function validateRunToken(
  token: string,
  options: ValidateRunTokenOptions = {},
): Promise<RunTokenContext> {
  const publicKey = decodeEs256PublicKeyPem(
    getJobAuthPublicKey(),
    'JOB_AUTH_PUBLIC_KEY',
  );

  const rawPayload = jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    clockTolerance: 60,
    ignoreExpiration: options.ignoreExpiration === true,
    ignoreNotBefore: isAuthClientTestEnv(),
    issuer: ISSUER,
  });

  const parseResult = compatibleRunTokenPayloadSchema.safeParse(rawPayload);

  if (!parseResult.success) {
    const validationErrors = parseResult.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');

    throw new Error(`Invalid run token structure: ${validationErrors}`);
  }

  const payload = parseResult.data;

  return {
    runId: Number(payload.sub),
    userId: payload.r.u ?? null,
    principal: payload.r.u ? 'user' : 'deployment',
    // Normalize pre-migration signed tokens at the validation boundary so
    // downstream authorization remains exclusively run-based.
    tokenType: 'run',
    version: payload.v,
  };
}
