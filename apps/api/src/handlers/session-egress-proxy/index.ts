import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Agent, fetch as undiciFetch } from 'undici';

import { db, eq, sessionSecrets } from '@roomote/db/server';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';
import { authorizeProxy } from '@roomote/sdk/server/session-egress';
import { redactEcho } from '@roomote/sdk/server/session-secrets';
import {
  SESSION_EGRESS_METHODS,
  SESSION_EGRESS_SUBSTITUTE_PREFIX,
  type SessionEgressAuthorization,
  type SessionEgressMethod,
} from '@roomote/types';

import type { Variables } from '../../types';
import { buildProxyResponseHeaders } from '../mcp/proxy-utils';

/**
 * Session egress substitution proxy: `/api/session-egress/<secretRef>/<path>`.
 *
 * The API-side counterpart of the Iron gateway for compute providers that
 * have no per-workload connector. A workload points an ordinary HTTP client
 * at the per-grant base URL and presents its substitute token in the grant's
 * own header slot (`Authorization: Bearer rses_...`, `x-api-key: rses_...`).
 * The API re-joins the live workload, Session, run, grant, generation and
 * expiry on every request, rewrites the path onto the approved origin,
 * replaces the substitute with the real credential, forwards, and releases
 * the response only after a second live check and a credential echo scan.
 *
 * What a sandbox can send is never authority on its own: the substitute is a
 * random capability bound to one workload generation and one grant, and every
 * check the gateway path performs is performed here too. What this path does
 * not have is a physical origin proof (the connector certificate); a copied
 * substitute is usable until the run ends, the lease lapses, or the grant is
 * revoked. Responses are buffered and bounded so the echo scan sees the whole
 * body; streaming upstreams are out of scope for this path.
 *
 * Nothing about a request or response body, path, query, header value, or
 * upstream error text is logged: only bounded reason codes.
 */

const LOG_PREFIX = '[session-egress-proxy]';
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 64;
const MAX_IN_FLIGHT_PER_WORKLOAD = 8;
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Client headers never forwarded. The credential slot is replaced, cookies
 * and every other credential-shaped header are dropped, and hop-by-hop or
 * routing headers are stripped so the origin sees a clean direct request.
 */
const REQUEST_HEADER_DENYLIST = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'proxy-authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  // The proxy asks for identity encoding so the echo scan sees plaintext.
  'accept-encoding',
]);

/** Upstream headers never relayed: session state and authentication challenges. */
const RESPONSE_HEADER_DENYLIST = new Set([
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'proxy-authenticate',
]);

const SUBSTITUTE_SHAPE = /^rses_[A-Za-z0-9_-]{32,}$/;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Allowed = Extract<SessionEgressAuthorization, { allowed: true }>;

/**
 * The substitute is the whole header value after the approved scheme. Only
 * the scheme compares case-insensitively; the value and its spacing are exact.
 */
export function presentedSubstitute(
  headerValue: string | undefined,
  headerPrefix: string,
): string | null {
  if (headerValue === undefined) return null;
  let value: string;
  if (headerPrefix === '') {
    value = headerValue;
  } else {
    if (
      headerValue.length <= headerPrefix.length ||
      headerValue.slice(0, headerPrefix.length).toLowerCase() !==
        headerPrefix.toLowerCase()
    )
      return null;
    value = headerValue.slice(headerPrefix.length);
  }
  return SUBSTITUTE_SHAPE.test(value) &&
    value.startsWith(SESSION_EGRESS_SUBSTITUTE_PREFIX)
    ? value
    : null;
}

/** Log-safe description: bounded reason codes and error class names only. */
function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const name = error.name || 'Error';
  if (name === 'AbortError') return 'request_aborted';
  if (name === 'TimeoutError') return 'request_timeout';
  const cause: unknown = error.cause;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
    return `${name}:${code}`;
  return name;
}

function buildUpstreamHeaders(
  requestHeaders: Headers,
  credential: Allowed['credential'] & object,
): Headers {
  const headers = new Headers();
  for (const [key, value] of requestHeaders.entries())
    if (!REQUEST_HEADER_DENYLIST.has(key.toLowerCase()))
      headers.set(key, value);
  headers.set('accept-encoding', 'identity');
  headers.set(
    credential.headerName,
    `${credential.headerPrefix}${credential.value}`,
  );
  return headers;
}

interface SessionEgressProxyOptions {
  fetch?: typeof undiciFetch;
  createAgent?: () => Agent;
}

export function createSessionEgressProxy(
  options: SessionEgressProxyOptions = {},
) {
  const doFetch = options.fetch ?? undiciFetch;
  const createAgent =
    options.createAgent ??
    (() =>
      new Agent({
        connect: createGuardedConnectOptions({
          allowedPrivateCidrs: undefined,
        }),
      }));
  const app = new Hono<{ Variables: Variables }>();
  let inFlight = 0;
  const inFlightByWorkload = new Map<string, number>();

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );

  const denied = (
    c: { json: (body: unknown, status: 403) => Response },
    secretRef: string,
    method: string,
    reason: string,
  ) => {
    console.warn(
      `${LOG_PREFIX} denied (secretRef=${secretRef}, method=${method}, reason=${reason})`,
    );
    return c.json({ error: 'session_egress_denied' }, 403);
  };

  const rejected = (
    c: { json: (body: unknown, status: 502) => Response },
    secretRef: string,
    method: string,
    reason: string,
  ) => {
    console.warn(
      `${LOG_PREFIX} upstream rejected (secretRef=${secretRef}, method=${method}, reason=${reason})`,
    );
    return c.json({ error: 'session_egress_upstream_rejected' }, 502);
  };

  app.onError((error, c) => {
    console.error(
      `${LOG_PREFIX} ${c.req.method} failed (${error instanceof Error ? error.name : 'Error'})`,
    );
    return c.json({ error: 'internal_error' }, 500);
  });

  const handle = async (c: {
    req: {
      url: string;
      method: string;
      param: (name: string) => string;
      raw: Request;
    };
    json: (body: unknown, status: 403 | 405 | 429 | 502) => Response;
  }) => {
    const secretRef = c.req.param('secretRef');
    const method = c.req.method.toUpperCase();
    if (!UUID_SHAPE.test(secretRef))
      return denied(c, 'invalid', method, 'unknown_grant');
    if (!(SESSION_EGRESS_METHODS as readonly string[]).includes(method))
      return c.json({ error: 'method_not_allowed' }, 405);
    const egressMethod = method as SessionEgressMethod;

    // The grant's nonsecret policy decides which header carries the substitute.
    const [grant] = await db
      .select({
        origin: sessionSecrets.origin,
        headerName: sessionSecrets.headerName,
        headerPrefix: sessionSecrets.headerPrefix,
      })
      .from(sessionSecrets)
      .where(eq(sessionSecrets.id, secretRef));
    if (!grant) return denied(c, secretRef, method, 'unknown_grant');

    const substitute = presentedSubstitute(
      c.req.raw.headers.get(grant.headerName) ?? undefined,
      grant.headerPrefix,
    );
    if (!substitute) return denied(c, secretRef, method, 'missing_substitute');

    // Path and query are re-rooted on the approved origin. URL normalization
    // resolves dot segments, so an escape shows up as a different origin.
    const url = new URL(c.req.url);
    const marker = `/${secretRef}`;
    const markerIndex = url.pathname.indexOf(marker);
    const upstreamPath =
      markerIndex === -1
        ? '/'
        : url.pathname.slice(markerIndex + marker.length) || '/';
    let target: URL;
    try {
      target = new URL(`${upstreamPath}${url.search}`, grant.origin);
      if (
        target.origin !== grant.origin ||
        target.username ||
        target.password ||
        !upstreamPath.startsWith('/') ||
        upstreamPath.startsWith('//')
      )
        throw new Error('destination_mismatch');
      assertEgressUrlAllowed(target);
    } catch {
      return denied(c, secretRef, method, 'destination_mismatch');
    }

    const request = await authorizeProxy({
      secretRef,
      substitute,
      method: egressMethod,
      path: `${target.pathname}${target.search}`,
      phase: 'request',
    });
    if (!request.allowed) return denied(c, secretRef, method, request.reason);
    const credential = request.credential;
    if (!credential) return denied(c, secretRef, method, 'malformed');

    const workloadInFlight = inFlightByWorkload.get(request.workloadId) ?? 0;
    if (
      inFlight >= MAX_IN_FLIGHT ||
      workloadInFlight >= MAX_IN_FLIGHT_PER_WORKLOAD
    ) {
      console.warn(
        `${LOG_PREFIX} concurrency limit (secretRef=${secretRef}, method=${method})`,
      );
      return c.json({ error: 'too_many_requests' }, 429);
    }
    inFlight++;
    inFlightByWorkload.set(request.workloadId, workloadInFlight + 1);

    const agent = createAgent();
    // No exchange outlives the grant or the workload lease.
    const budget = Math.min(
      UPSTREAM_TIMEOUT_MS,
      Date.parse(request.expiresAt) - Date.now(),
    );
    try {
      if (budget <= 0) return denied(c, secretRef, method, 'grant_expired');
      const signal = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(budget),
      ]);
      const bodyless = method === 'GET' || method === 'HEAD';
      const body = bodyless ? undefined : await c.req.raw.arrayBuffer();
      const headerValue = `${credential.headerPrefix}${credential.value}`;
      let upstream: Awaited<ReturnType<typeof doFetch>>;
      try {
        upstream = await doFetch(target, {
          dispatcher: agent,
          method,
          headers: Object.fromEntries(
            buildUpstreamHeaders(c.req.raw.headers, credential).entries(),
          ),
          ...(body === undefined ? {} : { body }),
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        return rejected(c, secretRef, method, failureReason(error));
      }

      // A redirect would carry the injected credential to a destination the
      // owner never approved.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        return rejected(c, secretRef, method, 'redirect_refused');
      }

      const declared = upstream.headers.get('content-length');
      if (declared && Number(declared) > MAX_RESPONSE_BODY_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        return rejected(c, secretRef, method, 'response_too_large');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = upstream.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_RESPONSE_BODY_BYTES) {
              await reader.cancel().catch(() => undefined);
              return rejected(c, secretRef, method, 'response_too_large');
            }
            chunks.push(chunk.value);
          }
        } catch (error) {
          return rejected(c, secretRef, method, failureReason(error));
        } finally {
          reader.releaseLock();
        }
      }
      const responseBody = Buffer.concat(chunks);

      // The origin can reflect the credential it received. Scan the body and
      // every relayed header for the literal value and its common encodings
      // before a single byte reaches the workload.
      const headers = buildProxyResponseHeaders(
        new Headers(Array.from(upstream.headers.entries())),
      );
      for (const name of RESPONSE_HEADER_DENYLIST) headers.delete(name);
      const scanned = [
        responseBody.toString('latin1'),
        ...Array.from(headers.values()),
      ];
      if (
        scanned.some(
          (text) =>
            text.includes(credential.value) ||
            text.includes(headerValue) ||
            redactEcho(text, credential.value, headerValue) === '[REDACTED]',
        )
      )
        return rejected(c, secretRef, method, 'credential_echo');

      // Release only against live state: a revocation, detach, or lease
      // expiry during the upstream exchange withholds the response.
      const release = await authorizeProxy({
        secretRef,
        substitute,
        method: egressMethod,
        path: `${target.pathname}${target.search}`,
        phase: 'response',
        authorizationId: request.authorizationId,
      });
      if (!release.allowed) return denied(c, secretRef, method, release.reason);

      headers.set('cache-control', 'no-store');
      const withoutBody =
        method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
      return new Response(withoutBody ? null : responseBody, {
        status: upstream.status,
        headers,
      });
    } finally {
      await agent.destroy().catch(() => undefined);
      inFlight--;
      const remaining = (inFlightByWorkload.get(request.workloadId) ?? 1) - 1;
      if (remaining > 0) inFlightByWorkload.set(request.workloadId, remaining);
      else inFlightByWorkload.delete(request.workloadId);
    }
  };

  app.all('/:secretRef', (c) => handle(c));
  app.all('/:secretRef/*', (c) => handle(c));

  return app;
}

export const sessionEgressProxy = createSessionEgressProxy();
