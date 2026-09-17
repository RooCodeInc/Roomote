import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getJobAuthPrivateKey, getJobAuthPublicKey } from './client-runtime';
import {
  decodeEs256PrivateKeyPem,
  decodeEs256PublicKeyPem,
} from './decode-es256-key';

const claims = z.object({
  iss: z.literal('rcc'),
  sub: z.string().min(1),
  aud: z.literal('roomote-session-broker'),
  exp: z.number().int(),
  r: z.object({ t: z.literal('session-broker'), c: z.string().uuid() }),
});

export interface SessionBrokerContext {
  tokenType: 'session-broker';
  userId: string;
  fastConversationId: string;
}

/** Internal server-to-API authority, never an upstream key or model tool argument. */
export async function createSessionBrokerToken(input: {
  userId: string;
  fastConversationId: string;
}): Promise<string> {
  const payload = claims.parse({
    iss: 'rcc',
    sub: input.userId,
    aud: 'roomote-session-broker',
    exp: Math.floor(Date.now() / 1000) + 120,
    r: { t: 'session-broker', c: input.fastConversationId },
  });
  return jwt.sign(
    payload,
    decodeEs256PrivateKeyPem(getJobAuthPrivateKey(), 'JOB_AUTH_PRIVATE_KEY'),
    { algorithm: 'ES256' },
  );
}

export async function validateSessionBrokerToken(
  token: string,
): Promise<SessionBrokerContext> {
  const payload = claims.parse(
    jwt.verify(
      token,
      decodeEs256PublicKeyPem(getJobAuthPublicKey(), 'JOB_AUTH_PUBLIC_KEY'),
      {
        algorithms: ['ES256'],
        issuer: 'rcc',
        audience: 'roomote-session-broker',
      },
    ),
  );
  return {
    tokenType: 'session-broker',
    userId: payload.sub,
    fastConversationId: payload.r.c,
  };
}
