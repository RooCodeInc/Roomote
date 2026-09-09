import {
  insertSessionSecretApproval,
  finalizeSessionSecret,
  listOwnedSessionSecretApprovals,
  listOwnedSessionSecrets,
  revokeOwnedSessionSecret,
  resolveOwnedSessionSecret,
  recordSessionSecretAudit,
  type SessionSecretContext,
} from '@roomote/db/server';
import {
  sessionSecretCreateSchema,
  sessionSecretPrepareSchema,
  sessionSecretRevokeSchema,
  sessionSecretRequestSchema,
  type SessionSecretRequestResult,
} from '@roomote/types';

import { assertEgressUrlAllowed, safeFetch } from './safe-fetch';

const ERROR = 'Secret request unavailable' as const;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DURATION_MS = 10_000;

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

function destination(origin: string, path: string): URL {
  let decoded = path;
  // Inspect nested encodings before URL normalization can erase traversal.
  for (let i = 0; i < 5; i++) {
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      /[\\\s#\x00-\x1f\x7f]/.test(decoded)
    )
      throw new Error(ERROR);
    const pathname = decoded.split('?')[0]!;
    if (
      pathname.includes('//') ||
      pathname.split('/').some((segment) => segment === '.' || segment === '..')
    )
      throw new Error(ERROR);
    const next = decodeURIComponent(decoded);
    if (next === decoded) {
      const url = new URL(path, origin);
      if (url.origin !== origin || url.username || url.password)
        throw new Error(ERROR);
      return url;
    }
    decoded = next;
  }
  throw new Error(ERROR);
}

/**
 * Conservative whole-body suppression for exact and common encoded echoes.
 * Arbitrary upstream transformations, partial leaks, hashes, and covert channels
 * cannot be universally redacted. Only approve an origin trusted with the secret.
 */
function redactEcho(body: string, secret: string, headerValue: string): string {
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

export async function requestWithSessionSecret(
  context: SessionSecretContext,
  rawArgs: unknown,
): Promise<SessionSecretRequestResult> {
  let audit: Parameters<typeof recordSessionSecretAudit>[0] = {
    outcome: 'denied',
  };
  let response: Response | undefined;
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const args = sessionSecretRequestSchema.parse(rawArgs);
    // Only trusted actor and schema-validated opaque IDs enter the audit. Never
    // record attacker-controlled paths, query strings, headers, or error causes.
    audit = {
      actorUserId: context.userId ?? null,
      secretRef: args.secretRef,
      method: args.method,
      outcome: 'denied',
    };
    const grant = await resolveOwnedSessionSecret(context, args.secretRef);
    const origin = approvedOrigin(grant.origin);
    const url = destination(origin, args.path);
    audit.destination = origin;
    const headerValue = grant.headerPrefix + grant.value;
    // Revalidate stored policy as well as entry input before using credentials.
    if (
      !['authorization', 'x-api-key', 'api-key'].includes(grant.headerName) ||
      !['', 'Bearer ', 'Basic ', 'Token '].includes(grant.headerPrefix) ||
      /[^\x20-\x7e]/.test(headerValue)
    )
      throw new Error(ERROR);
    await recordSessionSecretAudit({ ...audit, outcome: 'started' });
    const timeoutMs = Math.min(
      MAX_DURATION_MS,
      Date.parse(grant.expiresAt) - Date.now(),
    );
    if (timeoutMs <= 0) throw new Error(ERROR);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(ERROR));
      }, timeoutMs);
    });
    const perform = async (): Promise<SessionSecretRequestResult> => {
      await resolveOwnedSessionSecret(context, args.secretRef);
      if (controller.signal.aborted) throw new Error(ERROR);
      // No CIDR override is accepted or inherited from deployment configuration.
      response = await safeFetch(url, {
        method: args.method,
        headers: {
          accept: args.accept ?? 'application/json',
          'accept-encoding': 'identity',
          [grant.headerName]: headerValue,
        },
        signal: controller.signal,
      });
      // The deadline can win before fetch settles; outer cleanup has already run.
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error(ERROR);
      }
      if (response.status >= 300 && response.status < 400)
        throw new Error(ERROR);
      const length = response.headers.get('content-length');
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
      )
        throw new Error(ERROR);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (args.method === 'GET' && response.body) {
        const reader = response.body.getReader();
        bodyReader = reader;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new Error(ERROR);
            chunks.push(value);
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
          bodyReader = undefined;
        }
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      // Revocation/ownership changes during the request suppress its result.
      // A request already sent cannot be recalled from the approved upstream.
      await resolveOwnedSessionSecret(context, args.secretRef);
      if (controller.signal.aborted) throw new Error(ERROR);
      const result = {
        success: true as const,
        status: response.status,
        body: redactEcho(body, grant.value, headerValue),
      };
      return result;
    };
    const result = await Promise.race([perform(), deadline]);
    await recordSessionSecretAudit({ ...audit, outcome: 'succeeded' });
    return result;
  } catch {
    await recordSessionSecretAudit({
      ...audit,
      outcome: audit.destination ? 'failed' : 'denied',
    }).catch(() => {});
    return { success: false, error: ERROR };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (bodyReader) void bodyReader.cancel().catch(() => {});
    if (response?.body && !response.body.locked)
      void response.body.cancel().catch(() => {});
  }
}
