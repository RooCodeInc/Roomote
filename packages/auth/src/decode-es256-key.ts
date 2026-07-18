import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import { normalizePemEnvValue } from '@roomote/types';

type Es256KeyKind = 'private' | 'public';

const ACCEPTED_P256_CURVES = new Set(['prime256v1', 'P-256', 'secp256r1']);

function looksLikePem(value: string): boolean {
  return value.includes('-----BEGIN ') && value.includes('-----END ');
}

function wrapDerAsPem(der: Buffer, label: string): string {
  const body = der.toString('base64');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function describeKeyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadKeyObject(pem: string, kind: Es256KeyKind): KeyObject {
  return kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
}

/**
 * Ensure the PEM is a usable P-256 key for ES256 signing/verification.
 * Returns the PEM when valid; throws a clear config error otherwise.
 */
export function assertEs256KeyPem(
  pem: string,
  kind: Es256KeyKind,
  envKey: string,
): string {
  let key: KeyObject;
  try {
    key = loadKeyObject(pem, kind);
  } catch (error) {
    throw new Error(
      `${envKey} is not a valid ${kind} key for ES256 ` +
        `(${describeKeyError(error)}). Provide a base64-encoded P-256 ` +
        'PKCS#8/SPKI PEM (see SELF_HOSTING.md), a raw PEM, or base64 DER, ' +
        'or set R_AUTO_GENERATE_KEYS=true.',
    );
  }

  if (key.type !== 'private' && key.type !== 'public') {
    throw new Error(
      `${envKey} must be an asymmetric ${kind} key when using ES256.`,
    );
  }

  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `${envKey} must be an elliptic-curve P-256 ${kind} key for ES256, ` +
        `got ${key.asymmetricKeyType ?? 'unknown'}.`,
    );
  }

  const namedCurve = key.asymmetricKeyDetails?.namedCurve;
  if (namedCurve && !ACCEPTED_P256_CURVES.has(namedCurve)) {
    throw new Error(
      `${envKey} must use the P-256 curve for ES256, got ${namedCurve}.`,
    );
  }

  return pem;
}

function tryPemCandidate(
  candidate: string,
  kind: Es256KeyKind,
  envKey: string,
): string | undefined {
  const normalized = normalizePemEnvValue(candidate.trim());
  if (!looksLikePem(normalized)) {
    return undefined;
  }

  return assertEs256KeyPem(normalized, kind, envKey);
}

function tryDerCandidate(
  der: Buffer,
  kind: Es256KeyKind,
  envKey: string,
): string | undefined {
  const labels =
    kind === 'private'
      ? (['PRIVATE KEY', 'EC PRIVATE KEY'] as const)
      : (['PUBLIC KEY', 'EC PUBLIC KEY'] as const);

  for (const label of labels) {
    try {
      return assertEs256KeyPem(wrapDerAsPem(der, label), kind, envKey);
    } catch {
      // Try the next ASN.1 label.
    }
  }

  return undefined;
}

/**
 * Decode auth-key env material into PEM that jsonwebtoken accepts for ES256.
 *
 * Accepted encodings (matching install.sh, auto-generate, and common operator
 * mistakes that previously surfaces as
 * "secretOrPrivateKey must be an asymmetric key when using ES256"):
 * - base64-encoded PEM (canonical)
 * - raw PEM, including flattened/escaped-newline forms
 * - base64-encoded DER (PKCS#8 private or SPKI/SEC1 public)
 */
export function decodeEs256KeyPem(
  value: string,
  kind: Es256KeyKind,
  envKey: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `${envKey} is empty. Provide a base64-encoded P-256 ${kind} key ` +
        'or set R_AUTO_GENERATE_KEYS=true.',
    );
  }

  const rawPem = tryPemCandidate(trimmed, kind, envKey);
  if (rawPem) {
    return rawPem;
  }

  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 0) {
    throw new Error(`${envKey} is not valid base64 key material for ES256.`);
  }

  const decodedAsText = decoded.toString('utf8');
  const decodedPem = tryPemCandidate(decodedAsText, kind, envKey);
  if (decodedPem) {
    return decodedPem;
  }

  const derPem = tryDerCandidate(decoded, kind, envKey);
  if (derPem) {
    return derPem;
  }

  throw new Error(
    `${envKey} must be a base64-encoded P-256 ${kind} key (PEM or DER) ` +
      'for ES256. See SELF_HOSTING.md, or unset the auth keypair env vars ' +
      'and set R_AUTO_GENERATE_KEYS=true to let Roomote generate them.',
  );
}

export function decodeEs256PrivateKeyPem(
  value: string,
  envKey: string,
): string {
  return decodeEs256KeyPem(value, 'private', envKey);
}

export function decodeEs256PublicKeyPem(value: string, envKey: string): string {
  return decodeEs256KeyPem(value, 'public', envKey);
}
