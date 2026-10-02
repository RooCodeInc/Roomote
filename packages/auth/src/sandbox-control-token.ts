import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { getJobAuthPrivateKey, getJobAuthPublicKey } from './client-runtime';
import {
  decodeEs256PrivateKeyPem,
  decodeEs256PublicKeyPem,
} from './decode-es256-key';

const payloadSchema = z.object({
  iss: z.literal('rcc'),
  sub: z.string().regex(/^\d+$/),
  exp: z.number(),
  iat: z.number(),
  nbf: z.number(),
  v: z.literal(1),
  r: z.object({
    t: z.literal('sandbox-control'),
    p: z.literal('critique-capture'),
  }),
});

export type SandboxControlTokenContext = {
  runId: number;
  tokenType: 'sandbox-control';
  purpose: 'critique-capture';
  version: 1;
};

export async function createSandboxControlToken(input: {
  runId: number;
  timeoutMs?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'rcc' as const,
    sub: String(input.runId),
    exp: now + Math.ceil((input.timeoutMs ?? 60_000) / 1000),
    iat: now,
    nbf: now - 30,
    v: 1 as const,
    r: { t: 'sandbox-control' as const, p: 'critique-capture' as const },
  };
  return jwt.sign(
    payload,
    decodeEs256PrivateKeyPem(getJobAuthPrivateKey(), 'JOB_AUTH_PRIVATE_KEY'),
    { algorithm: 'ES256' },
  );
}

export async function validateSandboxControlToken(
  token: string,
): Promise<SandboxControlTokenContext> {
  const raw = jwt.verify(
    token,
    decodeEs256PublicKeyPem(getJobAuthPublicKey(), 'JOB_AUTH_PUBLIC_KEY'),
    { algorithms: ['ES256'], issuer: 'rcc', clockTolerance: 30 },
  );
  const payload = payloadSchema.parse(raw);
  return {
    runId: Number(payload.sub),
    tokenType: 'sandbox-control',
    purpose: payload.r.p,
    version: payload.v,
  };
}
