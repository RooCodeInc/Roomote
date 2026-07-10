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

const ISSUER = 'rcc';

export const createRunTokenOptionsSchema = z.object({
  runId: z.number(),
  // Null mints a deployment-service-principal token for runs with no human
  // driver (automation-initiated work).
  userId: z.string().nullable(),
  timeoutMs: z.number(),
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

  const privateKey = Buffer.from(getJobAuthPrivateKey(), 'base64').toString(
    'utf-8',
  );

  return jwt.sign(payload, privateKey, { algorithm: 'ES256' });
}

export async function validateRunToken(
  token: string,
  options: ValidateRunTokenOptions = {},
): Promise<RunTokenContext> {
  const publicKey = Buffer.from(getJobAuthPublicKey(), 'base64').toString(
    'utf-8',
  );

  const rawPayload = jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    clockTolerance: 60,
    ignoreExpiration: options.ignoreExpiration === true,
    ignoreNotBefore: isAuthClientTestEnv(),
    issuer: ISSUER,
  });

  const parseResult = runTokenPayloadSchema.safeParse(rawPayload);

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
    tokenType: payload.r.t,
    version: payload.v,
  };
}
