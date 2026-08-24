import jwt from 'jsonwebtoken';
import { z } from 'zod';

import {
  automationTokenPayloadSchema,
  type AutomationTokenContext,
  type AutomationTokenPayload,
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
export const MAX_AUTOMATION_TOKEN_TIMEOUT_MS = 15 * 60_000;

export const createAutomationTokenOptionsSchema = z.object({
  automationRunId: z.string().uuid(),
  leaseOwner: z.string().min(1),
  policyVersion: z.number().int().positive(),
  timeoutMs: z.number().positive().max(MAX_AUTOMATION_TOKEN_TIMEOUT_MS),
});

export type CreateAutomationTokenOptions = z.infer<
  typeof createAutomationTokenOptionsSchema
>;

export async function createAutomationToken(
  options: CreateAutomationTokenOptions,
): Promise<string> {
  const parsed = createAutomationTokenOptionsSchema.parse(options);
  const now = Math.floor(Date.now() / 1000);
  const payload: AutomationTokenPayload = {
    iss: ISSUER,
    sub: parsed.automationRunId,
    exp: now + Math.floor(parsed.timeoutMs / 1000),
    iat: now,
    nbf: now - 30,
    v: 1,
    r: {
      t: 'automation',
      p: 'deployment',
      pv: parsed.policyVersion,
      l: parsed.leaseOwner,
    },
  };

  return jwt.sign(
    payload,
    decodeEs256PrivateKeyPem(getJobAuthPrivateKey(), 'JOB_AUTH_PRIVATE_KEY'),
    { algorithm: 'ES256' },
  );
}

export async function validateAutomationToken(
  token: string,
): Promise<AutomationTokenContext> {
  const rawPayload = jwt.verify(
    token,
    decodeEs256PublicKeyPem(getJobAuthPublicKey(), 'JOB_AUTH_PUBLIC_KEY'),
    {
      algorithms: ['ES256'],
      clockTolerance: 60,
      ignoreNotBefore: isAuthClientTestEnv(),
      issuer: ISSUER,
    },
  );
  const parsed = automationTokenPayloadSchema.parse(rawPayload);

  return {
    automationRunId: parsed.sub,
    leaseOwner: parsed.r.l,
    policyVersion: parsed.r.pv,
    principal: 'deployment',
    tokenType: 'automation',
    userId: null,
    version: parsed.v,
  };
}
