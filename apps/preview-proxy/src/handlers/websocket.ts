import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type httpProxy from 'http-proxy';
import { DEFAULT_AUTH_BYPASS_HEADER_NAME } from '@roomote/types';
import { stripSuffixFromHost, parseHostForConfig } from '../lib/url-parser';
import {
  resolveRequest,
  type ResolvedRequest,
  type ResolverIdentifier,
} from '../services/resolver';
import { tryNestedFallback } from '../lib/nested-routing';
import { validateAuthCookieForTaskRun } from '../services/auth';
import { proxyWebSocket } from '../lib/proxy';
import { logger, escapeForLog } from '../lib/logger';
import { emitWsAccessLog } from '../lib/access-log';
import { config } from '../config';
import { getRequestContext, setRequestContext } from '../lib/request-context';

/**
 * Determine the request protocol from headers.
 */
function getRequestProtocol(req: IncomingMessage): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0]?.trim() || 'https';
  }
  return 'https';
}

/**
 * Extract cookie value from request headers.
 */
function getCookie(req: IncomingMessage, name: string): string | undefined {
  const cookies = req.headers.cookie;
  if (!cookies) return undefined;

  const match = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));

  return match ? match.slice(name.length + 1) : undefined;
}

/**
 * Filter out the preview_auth cookie from requests.
 */
function filterCookie(cookieHeader: string, name: string): string {
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => !c.startsWith(`${name}=`))
    .join('; ');
}

function upsertCookie(
  cookieHeader: string | undefined,
  name: string,
  value: string,
): string {
  const nextCookies = cookieHeader
    ? cookieHeader
        .split(';')
        .map((cookie) => cookie.trim())
        .filter(Boolean)
        .filter((cookie) => !cookie.startsWith(`${name}=`))
    : [];

  nextCookies.push(`${name}=${value}`);
  return nextCookies.join('; ');
}

function applyTrustedAuthProxyBypassHeader(
  req: IncomingMessage,
  resolution: Pick<
    ResolvedRequest,
    'authBypassHeaderName' | 'authBypassHeaderValue' | 'hasAuthProxy'
  >,
): void {
  if (!resolution.hasAuthProxy || !resolution.authBypassHeaderValue) {
    return;
  }

  req.headers[
    resolution.authBypassHeaderName ?? DEFAULT_AUTH_BYPASS_HEADER_NAME
  ] = resolution.authBypassHeaderValue;
}

export function getProxiedWebSocketOrigin(params: {
  currentOrigin: string | string[] | undefined;
  hasAuthProxy: boolean;
  host: string;
  sandboxUrl: string;
  suffix: string | undefined;
  wildcardPrefix: boolean | undefined;
  protocol: string;
}): string | undefined {
  const {
    currentOrigin,
    hasAuthProxy,
    host,
    sandboxUrl,
    suffix,
    wildcardPrefix,
    protocol,
  } = params;

  if (!hasAuthProxy) {
    return sandboxUrl;
  }

  if (wildcardPrefix) {
    return sandboxUrl;
  }

  if (suffix) {
    return `${protocol}://${host}`;
  }

  return Array.isArray(currentOrigin) ? currentOrigin[0] : currentOrigin;
}

/**
 * Handle a WebSocket upgrade request.
 * All async operations are completed before proxying to avoid
 * corrupting WebSocket frames with async operations during handshake.
 */
export async function handleWebSocketUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  proxy: httpProxy,
): Promise<void> {
  const startTime = process.hrtime.bigint();
  // In inner mode (suffix configured), prefer x-roomote-forwarded-host over
  // the host header. The sandbox auth-proxy rewrites host to a loopback
  // address (e.g. localhost:8081), but preserves the original public
  // hostname in x-roomote-forwarded-host.
  const host = config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX
    ? (req.headers['x-roomote-forwarded-host'] as string) || req.headers.host
    : req.headers.host;
  if (!host) {
    emitWsAccessLog(req, {
      outcome: 'bad_request',
      durationMs: Number(process.hrtime.bigint() - startTime) / 1e6,
    });
    socket.destroy();
    return;
  }

  try {
    // Parse host — use suffix stripping in inner mode, normal parse otherwise
    const suffix = config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
    const parsed = parseHostForConfig(host, suffix);

    let resolution: ResolvedRequest | null = null;

    if (parsed.isValid) {
      const { portName, taskId } = parsed;
      const identifier: ResolverIdentifier = { taskId: taskId! };

      // 1. Resolve target and auth requirements
      resolution = await resolveRequest(identifier, portName);

      // Nested fallback: if not_found in outer mode, try nested URL parsing
      if (resolution.status === 'not_found' && !suffix) {
        resolution = (await tryNestedFallback(host, 'WebSocket')) ?? resolution;
      }
    } else if (!suffix) {
      // In outer mode, try nested URL parsing when normal parse fails.
      // Nested URLs may not parse via parseHost if the inner ID isn't a
      // valid taskId from this proxy's perspective.
      resolution = await tryNestedFallback(host, 'WebSocket');
    }

    if (!resolution) {
      logger.warn(
        { host: escapeForLog(host) },
        'WebSocket upgrade: invalid host format',
      );
      emitWsAccessLog(req, {
        outcome: 'bad_request',
        durationMs: Number(process.hrtime.bigint() - startTime) / 1e6,
      });
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Handle non-active states. Note: redirect_to_direct returns 503 because
    // WebSocket connections cannot be redirected via HTTP 302.
    if (resolution.status !== 'active' || !resolution.sandboxUrl) {
      logger.debug(
        { host: escapeForLog(host), status: resolution.status },
        'WebSocket upgrade: sandbox not available or port not proxied',
      );
      emitWsAccessLog(req, {
        outcome: 'unavailable',
        statusCode: 503,
        durationMs: Number(process.hrtime.bigint() - startTime) / 1e6,
      });
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const requestUrl = new URL(req.url || '/', `http://${host}`);

    // 2. Check bypass escape hatches before auth
    let requiresAuth = resolution.requiresAuth;

    // Path-prefix bypass
    if (requiresAuth && resolution.authBypassPaths) {
      const pathname = requestUrl.pathname;
      if (
        resolution.authBypassPaths.some((prefix) => pathname.startsWith(prefix))
      ) {
        requiresAuth = false;
        logger.debug(
          { host: escapeForLog(host), pathname },
          'WebSocket auth bypassed via path prefix',
        );
      }
    }

    // Header/cookie bypass
    if (requiresAuth && resolution.authBypassHeaderValue) {
      const bypassHeader =
        resolution.authBypassHeaderName ?? DEFAULT_AUTH_BYPASS_HEADER_NAME;
      const headerVal = req.headers[bypassHeader];
      const cookieVal = getCookie(req, bypassHeader);
      if (
        headerVal === resolution.authBypassHeaderValue ||
        cookieVal === resolution.authBypassHeaderValue
      ) {
        requiresAuth = false;
        logger.debug(
          { host: escapeForLog(host) },
          'WebSocket auth bypassed via header/cookie',
        );
      }
    }

    // 2b. Check auth if required
    const inlineToken = requestUrl.searchParams.get('__preview_token');
    let inlineAuthResult: Awaited<
      ReturnType<typeof validateAuthCookieForTaskRun>
    > | null = null;
    let previewAuthCookie = getCookie(req, config.PREVIEW_AUTH_COOKIE_NAME);

    if (inlineToken) {
      requestUrl.searchParams.delete('__preview_token');
      req.url = requestUrl.pathname + requestUrl.search;

      if (resolution.taskRun) {
        inlineAuthResult = await validateAuthCookieForTaskRun(
          inlineToken,
          resolution.taskRun,
        );

        if (inlineAuthResult.valid) {
          previewAuthCookie = inlineToken;
          req.headers.cookie = upsertCookie(
            req.headers.cookie,
            config.PREVIEW_AUTH_COOKIE_NAME,
            inlineToken,
          );
        }
      }
    }

    const authResult =
      requiresAuth && resolution.taskRun
        ? inlineAuthResult?.valid
          ? inlineAuthResult
          : await validateAuthCookieForTaskRun(
              previewAuthCookie,
              resolution.taskRun,
            )
        : null;

    if (requiresAuth && resolution.taskRun) {
      if (!authResult?.valid) {
        logger.warn({ host: escapeForLog(host) }, 'WebSocket auth failed');
        emitWsAccessLog(req, {
          outcome: 'auth_denied',
          statusCode: 401,
          durationMs: Number(process.hrtime.bigint() - startTime) / 1e6,
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    applyTrustedAuthProxyBypassHeader(req, resolution);

    // 3. Handle cookie forwarding based on hasAuthProxy
    // Forward preview_auth ONLY when an auth-proxy instance sits in front of this port.
    // Otherwise, filter it out to prevent leakage to application backends.
    const originalCookie = req.headers.cookie;
    if (resolution.hasAuthProxy) {
      // Keep preview_auth for sandbox auth-proxy validation
    } else if (originalCookie) {
      // Filter out preview_auth - no auth-proxy on this port
      const filteredCookie = filterCookie(
        originalCookie,
        config.PREVIEW_AUTH_COOKIE_NAME,
      );
      if (filteredCookie) {
        req.headers.cookie = filteredCookie;
      } else {
        delete req.headers.cookie;
      }
    }

    // 4. Add forwarded host/proto headers for proper redirect handling.
    // In inner mode, strip the suffix so the inner sandbox's auth-proxy
    // sees the inner-only hostname.
    const forwardHost = suffix ? stripSuffixFromHost(host, suffix) : host;
    req.headers['x-roomote-forwarded-host'] = forwardHost;
    // Preserve the original public host separately for downstream
    // canonical URL generation without changing routing behavior.
    if (suffix) {
      req.headers['x-roomote-public-host'] = host;
    } else {
      delete req.headers['x-roomote-public-host'];
    }
    req.headers['x-roomote-forwarded-proto'] = getRequestProtocol(req);

    // 5. Remove incoming x-forwarded-* headers.
    // Preview-proxy owns these semantics and downstream layers rebuild the
    // forwarded values from x-roomote-* headers where needed.
    delete req.headers['x-forwarded-host'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-forwarded-port'];

    const requestContext = getRequestContext();
    if (requestContext) {
      req.headers['x-request-id'] = requestContext.requestId;
      req.headers.traceparent = requestContext.traceparent;
    }

    if (
      (req as IncomingMessage & { __dropTracestate?: boolean }).__dropTracestate
    ) {
      delete req.headers.tracestate;
    }

    // 6. WebSocket Origin policy:
    // - Direct auth-proxy routes preserve browser Origin for strict upstream
    //   Origin/X-Forwarded-Host checks.
    // - Wildcard_prefix routes (nested PREVIEW hop) use sandbox Origin so the
    //   handshake to the sandbox domain succeeds before reaching inner routing.
    // - Inner preview-proxy (suffix mode) restores Origin to the forwarded
    //   public host for downstream strict Origin/Host checks.
    // - Routes without auth-proxy keep sandbox Origin for legacy direct
    //   upstream handshakes.
    req.headers.origin = getProxiedWebSocketOrigin({
      currentOrigin: req.headers.origin,
      hasAuthProxy: resolution.hasAuthProxy,
      host,
      sandboxUrl: resolution.sandboxUrl,
      suffix,
      wildcardPrefix: resolution.wildcardPrefix,
      protocol: getRequestProtocol(req),
    });

    logger.debug(
      { host: escapeForLog(host), target: escapeForLog(resolution.sandboxUrl) },
      'WebSocket proxied',
    );
    setRequestContext({
      taskId: resolution.taskId,
      runId: resolution.taskRun?.id,
      upstreamTarget: resolution.sandboxUrl,
      outcome: 'proxied',
    });

    // 6. All async work complete - proxy synchronously
    proxyWebSocket(proxy, req, socket, head, resolution.sandboxUrl);

    emitWsAccessLog(req, {
      outcome: 'proxied',
      upstreamTarget: resolution.sandboxUrl,
      statusCode: 101,
      durationMs: Number(process.hrtime.bigint() - startTime) / 1e6,
    });
  } catch (error) {
    logger.error(
      { error, host: escapeForLog(host) },
      'WebSocket upgrade error',
    );
    emitWsAccessLog(req, {
      outcome: 'error',
      statusCode: 500,
      durationMs: Number(process.hrtime.bigint() - startTime) / 1e6,
    });
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
}
