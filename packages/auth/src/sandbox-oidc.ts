import { createHash, createPublicKey, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { Env } from '@roomote/env';
import type { SandboxOidcTokenPayload } from '@roomote/types';

import {
  getSandboxOidcPrivateKey,
  getSandboxOidcPublicKey,
  getSandboxOidcSecondaryPublicKey,
} from './client-runtime';

export const SANDBOX_OIDC_TOKEN_TTL_MS = 60 * 60 * 1000;
export const SANDBOX_OIDC_REFRESH_BUFFER_MS = 20 * 60 * 1000;
export const SANDBOX_OIDC_ISSUER_PATH = '';
export const SANDBOX_OIDC_METADATA_CACHE_TTL_SECONDS = 300;
export const SANDBOX_OIDC_METADATA_CACHE_CONTROL = `public, max-age=${SANDBOX_OIDC_METADATA_CACHE_TTL_SECONDS}, must-revalidate`;
const SANDBOX_OIDC_DISCOVERY_PATH = '/.well-known/openid-configuration';
const SANDBOX_OIDC_JWKS_PATH = '/api/oidc/jwks';

type SandboxOidcPublicJwk = JsonWebKey & {
  alg: 'ES256';
  kid: string;
  use: 'sig';
};

function decodePem(base64Pem: string): string {
  return Buffer.from(base64Pem, 'base64').toString('utf-8');
}

function normalizeUrlBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export function isSandboxOidcConfigured(): boolean {
  return Boolean(
    Env.SANDBOX_OIDC_PRIVATE_KEY?.trim() && Env.SANDBOX_OIDC_PUBLIC_KEY?.trim(),
  );
}

export function getSandboxOidcIssuer(): string {
  // This issuer URL is configured in customer IAM/OIDC provider trust policies,
  // so treat it as stable once deployed. It must point at apps/api, whose host
  // serves the root .well-known discovery endpoint and advertised JWKS URI.
  return normalizeUrlBase(Env.R_TRPC_URL);
}

export function getSandboxOidcKeyId(
  publicKey = getSandboxOidcPublicKey(),
): string {
  return createHash('sha256')
    .update(publicKey)
    .digest('base64url')
    .slice(0, 16);
}

function getSandboxOidcVerificationKeys(): string[] {
  const keys = [getSandboxOidcPublicKey(), getSandboxOidcSecondaryPublicKey()]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return [...new Set(keys)];
}

export function getSandboxOidcJwk(
  publicKeyPemBase64 = getSandboxOidcPublicKey(),
): SandboxOidcPublicJwk {
  const publicKey = createPublicKey(decodePem(publicKeyPemBase64));
  const exported = publicKey.export({ format: 'jwk' }) as JsonWebKey;

  return {
    ...exported,
    alg: 'ES256',
    kid: getSandboxOidcKeyId(publicKeyPemBase64),
    use: 'sig',
  };
}

export function getSandboxOidcJwks(): { keys: SandboxOidcPublicJwk[] } {
  return {
    keys: getSandboxOidcVerificationKeys().map((key) => getSandboxOidcJwk(key)),
  };
}

export function getSandboxOidcDiscoveryDocument(): Record<string, unknown> {
  const issuer = getSandboxOidcIssuer();

  return {
    issuer,
    jwks_uri: `${issuer}${SANDBOX_OIDC_JWKS_PATH}`,
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    claims_supported: [
      'sub',
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'nbf',
      'environment_id',
    ],
  };
}

export function getSandboxOidcDiscoveryPath(): string {
  return `${SANDBOX_OIDC_ISSUER_PATH}${SANDBOX_OIDC_DISCOVERY_PATH}`;
}

export function getSandboxOidcJwksPath(): string {
  return `${SANDBOX_OIDC_ISSUER_PATH}${SANDBOX_OIDC_JWKS_PATH}`;
}

export function createSandboxOidcToken({
  environmentId,
  audience,
  now = new Date(),
  timeoutMs = SANDBOX_OIDC_TOKEN_TTL_MS,
}: {
  environmentId: string;
  audience: string;
  now?: Date;
  timeoutMs?: number;
}): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const clockSkewGraceSeconds = 30;

  const payload: SandboxOidcTokenPayload = {
    iss: getSandboxOidcIssuer(),
    sub: `env:${environmentId}`,
    aud: audience,
    exp: nowSeconds + Math.floor(timeoutMs / 1000),
    iat: nowSeconds,
    nbf: nowSeconds - clockSkewGraceSeconds,
    jti: randomUUID(),
    environment_id: environmentId,
  };

  return jwt.sign(payload, decodePem(getSandboxOidcPrivateKey()), {
    algorithm: 'ES256',
    keyid: getSandboxOidcKeyId(),
  });
}
