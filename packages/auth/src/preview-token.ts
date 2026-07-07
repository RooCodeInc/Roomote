import jwt from 'jsonwebtoken';
import { z } from 'zod';

import {
  type PreviewTokenPayload,
  type PreviewTokenContext,
  previewTokenPayloadSchema,
} from '@roomote/types';

import {
  getPreviewAuthPrivateKey,
  getPreviewAuthPublicKey,
  isAuthClientTestEnv,
} from './client-runtime';

const ISSUER = 'rcc';
const PREVIEW_KEY_ID = 'preview-v1';

/**
 * Options for creating a preview token.
 * Preview tokens are user-scoped and work across all previews for that user.
 */
export const createPreviewTokenOptionsSchema = z.object({
  userId: z.string(),
  timeoutSeconds: z.number().optional(),
});

export type CreatePreviewTokenOptions = z.infer<
  typeof createPreviewTokenOptionsSchema
>;

/**
 * Create a preview auth token for a user.
 */
export async function createPreviewToken({
  userId,
  timeoutSeconds = 3600,
}: CreatePreviewTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const gracePeriod = 5 * 60; // 5 minutes
  const clockSkewGrace = 30; // 30 seconds

  const payload: PreviewTokenPayload = {
    iss: ISSUER,
    sub: 'preview',
    exp: now + timeoutSeconds + gracePeriod,
    iat: now,
    nbf: now - clockSkewGrace,
    v: 1,
    r: {
      u: userId,
      t: 'pt',
    },
  };

  const privateKey = Buffer.from(getPreviewAuthPrivateKey(), 'base64').toString(
    'utf-8',
  );

  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    keyid: PREVIEW_KEY_ID,
  });
}

export async function validatePreviewToken(
  token: string,
): Promise<PreviewTokenContext> {
  const publicKey = Buffer.from(getPreviewAuthPublicKey(), 'base64').toString(
    'utf-8',
  );

  const rawPayload = jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    clockTolerance: 60,
    ignoreNotBefore: isAuthClientTestEnv(),
    issuer: ISSUER,
  });

  const parseResult = previewTokenPayloadSchema.safeParse(rawPayload);

  if (!parseResult.success) {
    const validationErrors = parseResult.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');

    throw new Error(`Invalid preview token structure: ${validationErrors}`);
  }

  const payload = parseResult.data;

  return {
    userId: payload.r.u,
    tokenType: payload.r.t,
    version: payload.v,
  };
}
