import {
  insertSessionSecretApproval,
  finalizeSessionSecret,
  listOwnedSessionSecretApprovals,
  listOwnedSessionSecrets,
  revokeOwnedSessionSecret,
  type SessionSecretContext,
} from '@roomote/db/server';
import {
  isReadOnlyMethodPolicy,
  sessionSecretCreateSchema,
  sessionSecretPrepareSchema,
  sessionSecretRevokeSchema,
} from '@roomote/types';

import { assertEgressUrlAllowed } from './safe-fetch';

const ERROR = 'Secret request unavailable' as const;

function approvedOrigin(input: string): string {
  if (/[\s\\%]/.test(input)) throw new Error(ERROR);
  const url = assertEgressUrlAllowed(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(ERROR);
  }
  return url.origin;
}

/**
 * Conservative whole-body suppression for exact and common encoded echoes.
 * Arbitrary upstream transformations, partial leaks, hashes, and covert channels
 * cannot be universally redacted. Only approve an origin trusted with the secret.
 */
export function redactEcho(
  body: string,
  secret: string,
  headerValue: string,
): string {
  const needles = new Set<string>();
  for (const value of new Set([
    secret,
    headerValue,
    JSON.stringify(secret).slice(1, -1),
    JSON.stringify(headerValue).slice(1, -1),
  ])) {
    const bytes = Buffer.from(value);
    for (const variant of [
      value,
      encodeURIComponent(value),
      [...bytes]
        .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
        .join(''),
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
      JSON.stringify(value).slice(1, -1),
    ]) {
      needles.add(variant.toLowerCase());
    }
    // Match complete secret-only base64 groups even inside an encoded JSON/header envelope.
    for (let offset = 0; offset < 3; offset++) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(
        'base64',
      );
      const core = encoded.slice(
        Math.ceil((offset * 8) / 6),
        Math.floor(((offset + bytes.length) * 8) / 6),
      );
      needles.add(core.toLowerCase());
      needles.add(core.replace(/\+/g, '-').replace(/\//g, '_').toLowerCase());
    }
  }
  let normalized = body;
  for (let i = 0; i < 5; i++) {
    const candidates = [
      normalized.toLowerCase(),
      normalized.replace(/\s/g, '').toLowerCase(),
    ];
    if (
      [...needles].some((needle) =>
        candidates.some((candidate) => candidate.includes(needle)),
      )
    )
      return '[REDACTED]';
    const next = normalized
      .replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      })
      .replace(
        /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
        (_, unicode: string | undefined, hex: string | undefined) =>
          String.fromCharCode(parseInt(unicode ?? hex!, 16)),
      )
      .replace(/\\(["\\/])/g, '$1')
      .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (match, code: string) => {
        const value =
          code[0]?.toLowerCase() === 'x'
            ? parseInt(code.slice(1), 16)
            : Number(code);
        return value <= 0x10ffff ? String.fromCodePoint(value) : match;
      })
      .replace(
        /&(amp|lt|gt|quot|apos|sol|colon|equals|plus);/gi,
        (_, entity: string) =>
          ({
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'",
            sol: '/',
            colon: ':',
            equals: '=',
            plus: '+',
          })[entity.toLowerCase()]!,
      );
    if (next === normalized) break;
    normalized = next;
  }
  return body;
}

export async function prepareSessionSecret(
  context: SessionSecretContext,
  rawArgs: unknown,
) {
  try {
    const input = sessionSecretPrepareSchema.parse(rawArgs);
    const origin = approvedOrigin(input.origin);
    if (input.headerName !== 'authorization' && input.headerPrefix !== '')
      throw new Error(ERROR);
    return await insertSessionSecretApproval(context, { ...input, origin });
  } catch {
    throw new Error(ERROR);
  }
}

export async function createSessionSecret(
  context: SessionSecretContext,
  rawArgs: unknown,
) {
  try {
    const input = sessionSecretCreateSchema.parse(rawArgs);
    if (/[^\x21-\x7e]/.test(input.secret)) throw new Error(ERROR);
    return await finalizeSessionSecret(context, input, (pending) => {
      const origin = approvedOrigin(pending.origin);
      if (pending.headerName !== 'authorization' && pending.headerPrefix !== '')
        throw new Error(ERROR);
      // Write-capable policy needs explicit consent: the approving client must
      // echo the exact prepared method set. Older clients that never show it
      // cannot approve such a grant, and a successful key entry alone never
      // widens an approval beyond GET/HEAD.
      if (
        !isReadOnlyMethodPolicy(pending.allowedMethods) &&
        JSON.stringify(input.allowedMethods ?? null) !==
          JSON.stringify(pending.allowedMethods)
      )
        throw new Error(ERROR);
      if (
        redactEcho(
          pending.label + origin,
          input.secret,
          pending.headerPrefix + input.secret,
        ) === '[REDACTED]'
      )
        throw new Error(ERROR);
    });
  } catch {
    // Never retain causes: Drizzle errors may include bound plaintext values.
    throw new Error(ERROR);
  }
}

export async function listSessionSecretApprovals(
  context: SessionSecretContext,
) {
  try {
    return await listOwnedSessionSecretApprovals(context);
  } catch {
    throw new Error(ERROR);
  }
}

export async function listSessionSecrets(context: SessionSecretContext) {
  try {
    return await listOwnedSessionSecrets(context);
  } catch {
    throw new Error(ERROR);
  }
}

export async function revokeSessionSecret(
  context: SessionSecretContext,
  rawArgs: unknown,
) {
  try {
    const { secretRef } = sessionSecretRevokeSchema.parse(rawArgs);
    await revokeOwnedSessionSecret(context, secretRef);
  } catch {
    throw new Error(ERROR);
  }
}
