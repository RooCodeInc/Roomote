import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getJobAuthPrivateKey, getJobAuthPublicKey } from './client-runtime';
import {
  decodeEs256PrivateKeyPem,
  decodeEs256PublicKeyPem,
} from './decode-es256-key';

const AUDIENCE = 'roomote-credential-egress-controller';

const claims = z.object({
  iss: z.literal('rcc'),
  sub: z.literal('roomote-controller'),
  aud: z.literal(AUDIENCE),
  exp: z.number().int(),
  r: z.object({ t: z.literal('credential-egress-controller') }),
});

export interface CredentialEgressControllerContext {
  tokenType: 'credential-egress-controller';
}

/**
 * Short-lived controller -> API service credential for the credential egress
 * control plane. Signed with the deployment job-auth key the controller
 * already holds, under an audience no other API surface accepts, so a run
 * token, user token, MCP token, or gateway token can never stand in for it.
 * Sandboxes never hold the signing key and cannot mint one.
 */
export async function createCredentialEgressControllerToken(): Promise<string> {
  const payload = claims.parse({
    iss: 'rcc',
    sub: 'roomote-controller',
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60,
    r: { t: 'credential-egress-controller' },
  });
  return jwt.sign(
    payload,
    decodeEs256PrivateKeyPem(getJobAuthPrivateKey(), 'JOB_AUTH_PRIVATE_KEY'),
    { algorithm: 'ES256' },
  );
}

export async function validateCredentialEgressControllerToken(
  token: string,
): Promise<CredentialEgressControllerContext> {
  claims.parse(
    jwt.verify(
      token,
      decodeEs256PublicKeyPem(getJobAuthPublicKey(), 'JOB_AUTH_PUBLIC_KEY'),
      { algorithms: ['ES256'], issuer: 'rcc', audience: AUDIENCE },
    ),
  );
  return { tokenType: 'credential-egress-controller' };
}
