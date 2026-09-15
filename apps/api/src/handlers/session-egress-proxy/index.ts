import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Agent, fetch as undiciFetch } from 'undici';

import {
  db,
  eq,
  hashSessionEgressSubstitute,
  sessionEgressSubstitutes,
  sessionSecrets,
} from '@roomote/db/server';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';
import { authorizeProxy } from '@roomote/sdk/server/session-egress';
import { redactEcho } from '@roomote/sdk/server/session-secrets';
import {
  SESSION_EGRESS_METHODS,
  SESSION_EGRESS_PROXY_PATH,
  SESSION_EGRESS_SUBSTITUTE_PREFIX,
  type SessionEgressAuthorization,
  type SessionEgressMethod,
} from '@roomote/types';

import type { Variables } from '../../types';
import { buildProxyResponseHeaders } from '../mcp/proxy-utils';

/**
 * Session egress substitution proxy: `/api/session-egress/<upstream path>`.
 *
 * The API-side counterpart of the Iron gateway for compute providers that
 * have no per-workload connector. A workload uses one base URL for every
 * approved service and presents the service's substitute token as its
 * credential in any header (`Authorization: Bearer rses_...`,
 * `x-api-key: rses_...`, `private-token: rses_...`). The substitute alone
 * names the grant: the API re-joins the live workload,
 * Session, run, grant, generation and expiry on every request, rewrites the
 * path onto that grant's approved origin, replaces the substitute with the
 * real credential in the grant's own header slot, forwards, and releases the
 * response only after a second live check and a credential echo scan.
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
 * upstream error text is logged: only bounded reason codes and grant ids.
 */

const LOG_PREFIX = '[session-egress-proxy]';
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 64;
const MAX_IN_FLIGHT_PER_WORKLOAD = 8;
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Client headers never forwarded. The common credential slots are always
 * replaced, cookies are dropped, and hop-by-hop or routing headers are
 * stripped so the origin sees a clean direct request. Whatever header the
 * client actually presented the substitute in, and the grant's own header,
 * are removed per request on top of this list.
 */
const REQUEST_HEADER_DENYLIST = new Set([
  'authorization',
  'x-api-key',
  'api-key',
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

type Allowed = Extract<SessionEgressAuthorization, { allowed: true }>;

/**
 * A substitute is the whole header value, or the value after a single
 * authentication scheme (`Bearer`, `Basic`, `Token`, any case). The scheme the
 * client used does not matter: the grant decides the slot and scheme the
 * origin receives. Values are exact; no trimming, no repeated spaces.
 */
export function presentedSubstitute(
  headerValue: string | undefined,
): string | null {
  if (headerValue === undefined) return null;
  const space = headerValue.indexOf(' ');
  const value = space === -1 ? headerValue : headerValue.slice(space + 1);
  if (space !== -1 && !/^[A-Za-z]+$/.test(headerValue.slice(0, space)))
    return null;
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
  presentedIn: Iterable<string>,
): Record<string, string> {
  const dropped = new Set([
    ...REQUEST_HEADER_DENYLIST,
    ...presentedIn,
    credential.headerName,
  ]);
  const headers: Record<string, string> = {};
  for (const [key, value] of requestHeaders.entries())
    if (!dropped.has(key.toLowerCase())) headers[key] = value;
  headers['accept-encoding'] = 'identity';
  headers[credential.headerName] =
    `${credential.headerPrefix}${credential.value}`;
  return headers;
}

interface SessionEgressProxyOptions {
  fetch?: typeof undiciFetch;
  createAgent?: () => Agent;
  /** Where the app is mounted; the upstream path is everything after it. */
  mountPath?: string;
}

export function createSessionEgressProxy(
  options: SessionEgressProxyOptions = {},
) {
  const doFetch = options.fetch ?? undiciFetch;
  const mountPath = options.mountPath ?? SESSION_EGRESS_PROXY_PATH;
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
    grant: string,
    method: string,
    reason: string,
  ) => {
    console.warn(
      `${LOG_PREFIX} denied (grant=${grant}, method=${method}, reason=${reason})`,
    );
    return c.json({ error: 'session_egress_denied' }, 403);
  };

  const rejected = (
    c: { json: (body: unknown, status: 502) => Response },
    grant: string,
    method: string,
    reason: string,
  ) => {
    console.warn(
      `${LOG_PREFIX} upstream rejected (grant=${grant}, method=${method}, reason=${reason})`,
    );
    return c.json({ error: 'session_egress_upstream_rejected' }, 502);
  };

  app.onError((error, c) => {
    console.error(
      `${LOG_PREFIX} ${c.req.method} failed (${error instanceof Error ? error.name : 'Error'})`,
    );
    return c.json({ error: 'internal_error' }, 500);
  });

  app.all('/*', async (c) => {
    const method = c.req.method.toUpperCase();
    if (!(SESSION_EGRESS_METHODS as readonly string[]).includes(method))
      return c.json({ error: 'method_not_allowed' }, 405);
    const egressMethod = method as SessionEgressMethod;

    // The global guard runs before any database work so unauthenticated
    // traffic is bounded too; the per-workload guard needs the workload,
    // which only authorization can name.
    if (inFlight >= MAX_IN_FLIGHT) {
      console.warn(`${LOG_PREFIX} concurrency limit (method=${method})`);
      return c.json({ error: 'too_many_requests' }, 429);
    }
    inFlight++;
    let workloadKey: string | undefined;
    try {
      return await proxy(c, method, egressMethod, (workloadId) => {
        const current = inFlightByWorkload.get(workloadId) ?? 0;
        if (current >= MAX_IN_FLIGHT_PER_WORKLOAD) return false;
        workloadKey = workloadId;
        inFlightByWorkload.set(workloadId, current + 1);
        return true;
      });
    } finally {
      inFlight--;
      if (workloadKey) {
        const remaining = (inFlightByWorkload.get(workloadKey) ?? 1) - 1;
        if (remaining > 0) inFlightByWorkload.set(workloadKey, remaining);
        else inFlightByWorkload.delete(workloadKey);
      }
    }
  });

  const proxy = async (
    c: Context<{ Variables: Variables }>,
    method: string,
    egressMethod: SessionEgressMethod,
    admitWorkload: (workloadId: string) => boolean,
  ): Promise<Response> => {
    // Exactly one substitute may be presented, in any header: the grant's
    // own header name decides where the origin receives the real key, so the
    // client's choice of slot only has to be unambiguous.
    const presentedIn = new Set<string>();
    const presented = new Set<string>();
    for (const [name, value] of c.req.raw.headers.entries()) {
      const token = presentedSubstitute(value);
      if (!token) continue;
      presentedIn.add(name.toLowerCase());
      presented.add(token);
    }
    if (presented.size !== 1)
      return denied(
        c,
        'unknown',
        method,
        presented.size ? 'ambiguous_substitute' : 'missing_substitute',
      );
    const [substitute] = presented as Set<string>;

    // The token names the grant; its nonsecret policy names the origin. The
    // live decision below re-checks everything; this read only routes.
    const [grant] = await db
      .select({ secretRef: sessionSecrets.id, origin: sessionSecrets.origin })
      .from(sessionEgressSubstitutes)
      .innerJoin(
        sessionSecrets,
        eq(sessionSecrets.id, sessionEgressSubstitutes.secretId),
      )
      .where(
        eq(
          sessionEgressSubstitutes.tokenHash,
          hashSessionEgressSubstitute(substitute!),
        ),
      );
    if (!grant) {
      const unknown = await authorizeProxy({
        substitute,
        method: egressMethod,
        path: '/',
        phase: 'request',
      });
      return denied(
        c,
        'unknown',
        method,
        unknown.allowed ? 'malformed' : unknown.reason,
      );
    }

    // Path and query are re-rooted on the approved origin. URL normalization
    // resolves dot segments, so an escape shows up as a different origin.
    const url = new URL(c.req.url);
    const upstreamPath = url.pathname.startsWith(mountPath)
      ? url.pathname.slice(mountPath.length) || '/'
      : '/';
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
      return denied(c, grant.secretRef, method, 'destination_mismatch');
    }

    const request = await authorizeProxy({
      substitute,
      method: egressMethod,
      path: `${target.pathname}${target.search}`,
      phase: 'request',
    });
    if (!request.allowed)
      return denied(c, grant.secretRef, method, request.reason);
    const credential = request.credential;
    if (!credential) return denied(c, grant.secretRef, method, 'malformed');

    if (!admitWorkload(request.workloadId)) {
      console.warn(
        `${LOG_PREFIX} concurrency limit (grant=${grant.secretRef}, method=${method})`,
      );
      return c.json({ error: 'too_many_requests' }, 429);
    }

    const agent = createAgent();
    // No exchange outlives the grant or the workload lease.
    const budget = Math.min(
      UPSTREAM_TIMEOUT_MS,
      Date.parse(request.expiresAt) - Date.now(),
    );
    try {
      if (budget <= 0)
        return denied(c, grant.secretRef, method, 'grant_expired');
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
          headers: buildUpstreamHeaders(
            c.req.raw.headers,
            credential,
            presentedIn,
          ),
          ...(body === undefined ? {} : { body }),
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        return rejected(c, grant.secretRef, method, failureReason(error));
      }

      // A redirect would carry the injected credential to a destination the
      // owner never approved.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        return rejected(c, grant.secretRef, method, 'redirect_refused');
      }

      const declared = upstream.headers.get('content-length');
      if (declared && Number(declared) > MAX_RESPONSE_BODY_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        return rejected(c, grant.secretRef, method, 'response_too_large');
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
              return rejected(c, grant.secretRef, method, 'response_too_large');
            }
            chunks.push(chunk.value);
          }
        } catch (error) {
          return rejected(c, grant.secretRef, method, failureReason(error));
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
        return rejected(c, grant.secretRef, method, 'credential_echo');

      // Release only against live state: a revocation, detach, or lease
      // expiry during the upstream exchange withholds the response.
      const release = await authorizeProxy({
        substitute,
        method: egressMethod,
        path: `${target.pathname}${target.search}`,
        phase: 'response',
        authorizationId: request.authorizationId,
      });
      if (!release.allowed)
        return denied(c, grant.secretRef, method, release.reason);

      headers.set('cache-control', 'no-store');
      const withoutBody =
        method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
      return new Response(withoutBody ? null : responseBody, {
        status: upstream.status,
        headers,
      });
    } finally {
      await agent.destroy().catch(() => undefined);
    }
  };

  return app;
}

export const sessionEgressProxy = createSessionEgressProxy();

/**
 * Serve the proxy at the root of a dedicated hostname. A request whose host
 * is `proxyHost` is re-addressed onto the proxy path and handed to the same
 * app, so there is exactly one route and one set of checks; only the address
 * a client uses differs. Lets SDK clients with a host-only override use the
 * proxy without a path prefix.
 */
export function sessionEgressProxyHostAlias(
  proxy: Hono<{ Variables: Variables }>,
  proxyHost: string,
): MiddlewareHandler<{ Variables: Variables }> {
  const host = proxyHost.toLowerCase();
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (
      url.hostname.toLowerCase() !== host ||
      url.pathname.startsWith(`${SESSION_EGRESS_PROXY_PATH}/`) ||
      url.pathname === SESSION_EGRESS_PROXY_PATH
    )
      return next();
    url.pathname = `${SESSION_EGRESS_PROXY_PATH}${url.pathname}`;
    return proxy.fetch(new Request(url, c.req.raw));
  };
}
