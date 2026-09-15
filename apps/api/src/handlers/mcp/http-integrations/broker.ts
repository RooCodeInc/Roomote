import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fetch, Agent } from 'undici';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';
import { z } from 'zod';
import {
  recordSessionSecretAudit,
  resolveOwnedSessionSecret,
  SessionSecretUnavailableError,
  type SessionSecretContext,
} from '@roomote/db/server';
import { redactEcho } from '@roomote/sdk/server/session-secrets';
import { isSessionEgressCredentialHeaderName } from '@roomote/types';

/**
 * Fail-closed broker errors keep their client-facing message but carry a
 * bounded, nonsecret `reason` for server logs. A reason never includes a
 * destination, path, header, body, credential or upstream error text.
 */
class IntegrationRequestError extends Error {
  readonly reason: string;

  constructor(reason: string, message = 'Integration request failed') {
    super(message);
    this.name = 'IntegrationRequestError';
    this.reason = reason;
  }
}

const abortReasons: Record<string, string> = {
  AbortError: 'request_aborted',
  TimeoutError: 'request_timeout',
};

/**
 * Log-safe failure description: the bounded reason of a known fail-closed
 * error, otherwise only error class names plus an uppercase transport code
 * (ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, ...) when undici exposes one. Never a
 * message: undici and database errors can echo destinations, credentials or
 * bound values.
 */
export function integrationFailureReason(error: unknown): string {
  if (error instanceof IntegrationRequestError) return error.reason;
  if (error instanceof SessionSecretUnavailableError) return error.reason;
  if (!(error instanceof Error)) return 'unknown';
  const name = error.name || 'Error';
  if (abortReasons[name]) return abortReasons[name];
  const cause: unknown = error.cause;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
    return `${name}:${code}`;
  if (cause instanceof Error && cause.name && cause.name !== 'Error')
    return `${name}:${cause.name}`;
  return name;
}

const SAFE_INTEGRATION_ID = /^(?:[a-z][a-z0-9-]{0,63}|session:[0-9a-f-]{36})$/;

function logIntegrationFailure(
  scope: string,
  integrationId: unknown,
  method: unknown,
  error: unknown,
) {
  const id =
    typeof integrationId === 'string' && SAFE_INTEGRATION_ID.test(integrationId)
      ? integrationId
      : 'invalid';
  console.warn(
    `[HTTP integrations] integration_request failed (scope=${scope}, integration=${id}, method=${typeof method === 'string' ? method : 'invalid'}, reason=${integrationFailureReason(error)})`,
  );
}

const methods = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const maxBody = 1024 * 1024;
const maxResponse = 2 * 1024 * 1024;

// Reject ambiguous routing rather than relying on differing proxy/upstream decoders.
function validPath(value: string, query: boolean): boolean {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\#\s\u0000-\u001f\u007f]/.test(value)
  )
    return false;
  if (!query && value.includes('?')) return false;
  const pathname = value.split('?')[0]!;
  if (
    pathname.includes('//') ||
    /%(?:25|2e|2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathname)
  )
    return false;
  if (pathname.split('/').some((part) => part === '.' || part === '..'))
    return false;
  try {
    decodeURIComponent(value);
  } catch {
    return false;
  }
  return true;
}

const manifestSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        description: z.string().min(1).max(1024),
        origin: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === 'https:' &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              url.pathname === '/' &&
              /^https:\/\/[^/?#\\]+\/?$/.test(value)
            );
          }),
        rules: z
          .array(
            z
              .object({
                method: methods,
                pathPrefix: z
                  .string()
                  .max(4096)
                  .refine(
                    (value) =>
                      validPath(value, false) &&
                      (value === '/' || !value.endsWith('/')),
                  ),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        credential: z
          .object({
            header: z
              .string()
              .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/)
              .refine(
                (value) =>
                  !/^(host|cookie|set-cookie|proxy-.*|connection|content-.*|transfer-encoding|te|trailer|upgrade|accept-encoding)$/i.test(
                    value,
                  ),
              ),
            valueEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
            prefix: z
              .string()
              .max(4096)
              .regex(/^[\x20-\x7e]*$/)
              .optional(),
          })
          .strict(),
        allowedUserIds: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  );

export const integrationRequestSchema = z
  .object({
    integrationId: z.string().max(64),
    method: methods,
    path: z
      .string()
      .max(8192)
      .refine((value) => validPath(value, true)),
    body: z
      .string()
      .max(maxBody)
      .refine((value) => Buffer.byteLength(value) <= maxBody)
      .nullish()
      .describe(
        'Request body for a permitted write. For GET/HEAD omit, use null, or use an empty string; nonempty bodies are rejected.',
      ),
    contentType: z
      .enum([
        'application/json',
        'text/plain',
        'application/x-www-form-urlencoded',
      ])
      .nullish()
      .describe(
        'Optional request content type; omit or use null when unused. Ignored for GET/HEAD.',
      ),
    accept: z
      .enum(['application/json', 'text/plain'])
      .nullish()
      .describe('Optional response preference for Session grants only.'),
  })
  .strict();

export function loadHttpIntegrationsConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.R_HTTP_INTEGRATIONS_CONFIG_PATH)
    throw new Error(
      'HTTP integrations requires R_HTTP_INTEGRATIONS_CONFIG_PATH',
    );
  try {
    const integrations = manifestSchema.parse(
      JSON.parse(readFileSync(env.R_HTTP_INTEGRATIONS_CONFIG_PATH, 'utf8')),
    );
    return { integrations };
  } catch {
    throw new Error(
      'Invalid HTTP integrations configuration: check integration manifest',
    );
  }
}

export type HttpIntegrationsConfig = ReturnType<
  typeof loadHttpIntegrationsConfig
>;
let active = 0;
const scopes = new Map<string, number>();

/**
 * Operator-manifest requests and `session:` grant reads share this broker.
 *
 * For `session:` IDs this is the read-only floor: a GET or HEAD made by the
 * API itself, available on every compute provider and to Fast. It is never
 * widened; a grant's `allowedMethods` apply to the session egress proxy
 * (`apps/api/src/handlers/session-egress-proxy`), where attached runs use
 * ordinary clients with a delivered substitute token.
 */
export async function integrationRequest(
  config: HttpIntegrationsConfig,
  scope: string,
  input: unknown,
  userId: string,
  signal?: AbortSignal,
  resolveContext?: () => Promise<SessionSecretContext>,
) {
  // The reserved prefix cannot collide with operator manifest IDs.
  const parsed = integrationRequestSchema.safeParse(input);
  const rawId =
    input && typeof input === 'object' && 'integrationId' in input
      ? input.integrationId
      : undefined;
  const secretRef = z
    .string()
    .uuid()
    .safeParse(
      typeof rawId === 'string' && rawId.startsWith('session:')
        ? rawId.slice(8)
        : undefined,
    );
  if (!secretRef.success) {
    try {
      return await performIntegrationRequest(
        config,
        scope,
        input,
        userId,
        signal,
      );
    } catch (error) {
      logIntegrationFailure(
        scope,
        rawId,
        parsed.success ? parsed.data.method : undefined,
        error,
      );
      throw error;
    }
  }
  let audit: Parameters<typeof recordSessionSecretAudit>[0] = {
    secretRef: secretRef.data,
    outcome: 'denied',
  };
  const completionId = randomUUID();
  try {
    if (!resolveContext)
      throw new IntegrationRequestError('context_unavailable');
    if (!parsed.success) throw new IntegrationRequestError('malformed_request');
    const context = await resolveContext();
    const grant = await resolveOwnedSessionSecret(context, secretRef.data);
    const args = parsed.data;
    if (args.method !== 'GET' && args.method !== 'HEAD')
      throw new IntegrationRequestError('method_not_allowed');
    if (args.path.length > 2048)
      throw new IntegrationRequestError('path_too_long');
    audit = {
      ...audit,
      actorUserId: context.userId,
      method: args.method,
      destination: grant.origin,
    };
    const origin = assertEgressUrlAllowed(grant.origin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== grant.origin ||
      !isSessionEgressCredentialHeaderName(grant.headerName) ||
      !['', 'Bearer ', 'Basic ', 'Token '].includes(grant.headerPrefix) ||
      (grant.headerName !== 'authorization' && grant.headerPrefix !== '')
    )
      throw new IntegrationRequestError('grant_policy_invalid');
    const revalidate = async () => {
      const live = await resolveContext();
      if (
        live.sessionId !== context.sessionId ||
        live.userId !== context.userId
      )
        throw new IntegrationRequestError('binding_changed');
      await resolveOwnedSessionSecret(live, secretRef.data);
    };
    await recordSessionSecretAudit({ ...audit, outcome: 'started' });
    const result = await performIntegrationRequest(
      {
        integrations: [
          {
            id: args.integrationId,
            description: grant.label,
            origin: grant.origin,
            rules: [
              { method: 'GET', pathPrefix: '/' },
              { method: 'HEAD', pathPrefix: '/' },
            ],
            credential: {
              header: grant.headerName,
              prefix: grant.headerPrefix,
              valueEnv: '',
            },
          },
        ],
      },
      scope,
      args,
      userId,
      signal,
      { value: grant.value, expiresAt: grant.expiresAt, revalidate },
    );
    await recordSessionSecretAudit({
      ...audit,
      id: completionId,
      outcome: 'succeeded',
    });
    // Audit persistence can yield too. Do not release data after an in-flight revocation.
    await revalidate();
    return result;
  } catch (error) {
    const outcome = audit.destination ? 'failed' : 'denied';
    // Bounded metadata only: the audit row and this line carry no path,
    // query, header, body, credential or upstream error text.
    console.warn(
      `[HTTP integrations] Session grant request ${outcome} (scope=${scope}, secretRef=${secretRef.data}, method=${parsed.success ? parsed.data.method : 'invalid'}, reason=${integrationFailureReason(error)})`,
    );
    await recordSessionSecretAudit({
      ...audit,
      id: completionId,
      outcome,
    }).catch(() => {});
    throw new IntegrationRequestError(
      integrationFailureReason(error),
      'Secret request unavailable',
    );
  }
}

async function performIntegrationRequest(
  config: HttpIntegrationsConfig,
  scope: string,
  input: unknown,
  userId: string,
  signal?: AbortSignal,
  sessionGrant?: {
    value: string;
    /** Null: the grant is kept until revoked. */
    expiresAt: string | null;
    revalidate: () => Promise<void>;
  },
) {
  const parsed = integrationRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new IntegrationRequestError(
      'malformed_request',
      'Invalid integration request',
    );
  const args = parsed.data;
  const integration = config.integrations.find(
    (item) =>
      item.id === args.integrationId &&
      (!item.allowedUserIds || item.allowedUserIds.includes(userId)),
  );
  if (!integration)
    throw new IntegrationRequestError(
      'unknown_integration',
      'Unknown integration',
    );
  const url = new URL(args.path, integration.origin);
  if (
    url.origin !== new URL(integration.origin).origin ||
    !integration.rules.some(
      (rule) =>
        rule.method === args.method &&
        (rule.pathPrefix === '/' ||
          url.pathname === rule.pathPrefix ||
          url.pathname.startsWith(`${rule.pathPrefix}/`)),
    )
  )
    throw new IntegrationRequestError(
      'destination_not_allowed',
      'Integration destination or method is not allowed',
    );
  const bodyless = args.method === 'GET' || args.method === 'HEAD';
  if (bodyless && args.body != null && args.body !== '')
    throw new IntegrationRequestError(
      'body_not_allowed',
      'This method does not accept a body',
    );
  if (active >= 32 || (scopes.get(scope) ?? 0) >= 4)
    throw new IntegrationRequestError(
      'concurrency_limit',
      'Integration request concurrency limit reached',
    );
  active++;
  scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  let agent: Agent | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Awaited<ReturnType<typeof fetch>> | undefined;
  let complete = false;
  try {
    assertEgressUrlAllowed(url);
    // Resolve on each request so rotation never requires reloading the manifest.
    const secret =
      sessionGrant?.value ?? process.env[integration.credential.valueEnv];
    const credential = `${integration.credential.prefix ?? ''}${secret ?? ''}`;
    if (
      !secret ||
      secret.length > 4096 ||
      !/^[\x20-\x7e]+$/.test(secret) ||
      credential.length > (sessionGrant ? 4103 : 4096)
    )
      throw new IntegrationRequestError('credential_invalid');
    agent = new Agent({
      connect: createGuardedConnectOptions({ allowedPrivateCidrs: undefined }),
    });
    const timeoutMs = sessionGrant
      ? Math.min(
          10_000,
          sessionGrant.expiresAt
            ? Date.parse(sessionGrant.expiresAt) - Date.now()
            : 10_000,
        )
      : 30_000;
    if (timeoutMs <= 0) throw new IntegrationRequestError('grant_expired');
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // Bound every upstream await even when a stream does not honor abort itself.
    const wait = <T>(operation: Promise<T>): Promise<T> => {
      if (!sessionGrant) return operation;
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          requestSignal.removeEventListener('abort', abort);
          // The composite signal carries the source's reason: the deadline
          // aborts with a TimeoutError, the caller with an AbortError.
          const cause: unknown = requestSignal.reason;
          reject(
            new IntegrationRequestError(
              (cause instanceof Error && abortReasons[cause.name]) ||
                'request_aborted',
              'Secret request unavailable',
            ),
          );
        };
        requestSignal.addEventListener('abort', abort, { once: true });
        if (requestSignal.aborted) abort();
        operation
          .then(resolve, reject)
          .finally(() => requestSignal.removeEventListener('abort', abort));
      });
    };
    await wait(Promise.resolve(sessionGrant?.revalidate()));
    requestSignal.throwIfAborted();
    const pendingResponse = fetch(url, {
      dispatcher: agent,
      signal: requestSignal,
      redirect: 'manual',
      method: args.method,
      headers: {
        [integration.credential.header]: credential,
        ...(sessionGrant
          ? {
              accept: args.accept ?? 'application/json',
              'accept-encoding': 'identity',
            }
          : {}),
        ...(!bodyless && args.contentType
          ? { 'content-type': args.contentType }
          : {}),
      },
      ...(!bodyless && args.body != null ? { body: args.body } : {}),
    });
    if (sessionGrant)
      void pendingResponse.then(
        (lateResponse) => {
          if (requestSignal.aborted)
            void lateResponse.body?.cancel().catch(() => {});
        },
        () => {},
      );
    response = await wait(pendingResponse);
    if (response.status >= 300 && response.status < 400)
      throw new IntegrationRequestError('redirect_refused');
    const contentType = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (
      args.method !== 'HEAD' &&
      response.status !== 204 &&
      (!contentType ||
        !(
          contentType.startsWith('text/') ||
          contentType === 'application/json' ||
          /^application\/[a-z0-9.+-]+\+json$/.test(contentType)
        ))
    )
      throw new IntegrationRequestError('content_type_rejected');
    const responseLimit = sessionGrant ? 64 * 1024 : maxResponse;
    const length = response.headers.get('content-length');
    if (
      (sessionGrant && length && !/^\d+$/.test(length)) ||
      Number(length) > responseLimit
    )
      throw new IntegrationRequestError('content_length_rejected');
    reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const chunk = await wait(reader.read());
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > responseLimit)
          throw new IntegrationRequestError('response_too_large');
        chunks.push(chunk.value);
      }
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'retry-after', 'x-request-id']) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    if (
      [body, ...Object.values(headers)].some(
        (value) => value.includes(secret) || value.includes(credential),
      )
    )
      throw new IntegrationRequestError('credential_echo');
    if (
      sessionGrant &&
      [body, ...Object.values(headers)].some(
        (value) => redactEcho(value, secret, credential) === '[REDACTED]',
      )
    )
      throw new IntegrationRequestError('credential_echo_encoded');
    await wait(Promise.resolve(sessionGrant?.revalidate()));
    requestSignal.throwIfAborted();
    complete = true;
    return { status: response.status, headers, body };
  } catch (error) {
    // Undici errors can include destinations or request credentials. Never
    // relay them; keep only the bounded reason for the caller's log line.
    throw new IntegrationRequestError(
      integrationFailureReason(error),
      'Integration request failed: upstream unavailable or response rejected',
    );
  } finally {
    if (!complete) {
      const cancelled = (
        reader ? reader.cancel() : response?.body?.cancel()
      )?.catch(() => {});
      if (!sessionGrant) await cancelled;
    }
    reader?.releaseLock();
    if (agent) {
      const destroyed = agent.destroy().catch(() => {});
      if (!sessionGrant) await destroyed;
    }
    active--;
    const remaining = (scopes.get(scope) ?? 1) - 1;
    if (remaining) scopes.set(scope, remaining);
    else scopes.delete(scope);
  }
}
