import http from 'node:http';
import { appendFile } from 'node:fs/promises';
import net from 'node:net';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import jwt from 'jsonwebtoken';
import { PRODUCT_NAME, slugToPortKey } from '@roomote/types';

import { captureWorkerException } from '../monitoring/sentry';

const ISSUER = 'rcc';

const DEFAULT_COOKIE_NAME = 'preview_auth';

export const PROXY_ACCESS_LOG_PATH = '/tmp/proxy-access.log';

/**
 * Loopback addresses to try when connecting to local services.
 * Services may bind to IPv4 (127.0.0.1) or IPv6 (::1) depending on their
 * configuration. We try IPv4 first for backward compatibility, then IPv6.
 */
const LOOPBACK_ADDRESSES = ['127.0.0.1', '[::1]'] as const;

/**
 * Cache of resolved loopback addresses per port.
 * Once we discover which address a port is reachable on, we cache it
 * to avoid probing on every request.
 */
export const loopbackCache = new Map<number, string>();

/**
 * Test if a TCP connection can be established to a given host:port.
 * Returns true if the connection succeeds, false otherwise.
 */
export function testConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Strip brackets from IPv6 for net.connect (it needs raw address)
    const cleanHost = host.replace(/^\[|\]$/g, '');

    const sock = net.connect({ host: cleanHost, port }, () => {
      sock.destroy();
      resolve(true);
    });

    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });

    sock.setTimeout(500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Resolve which loopback address a port is reachable on.
 * Tries each address in order, caches the result.
 * Returns the address in URL-safe format (e.g., '[::1]' for IPv6).
 */
export async function resolveLoopback(port: number): Promise<string> {
  const cached = loopbackCache.get(port);

  if (cached) {
    return cached;
  }

  for (const addr of LOOPBACK_ADDRESSES) {
    if (await testConnection(addr, port)) {
      loopbackCache.set(port, addr);
      console.log(`[auth-proxy] Resolved port ${port} -> ${addr}`);
      return addr;
    }
  }

  // Default to IPv4 if nothing responds (service may not be up yet)
  return LOOPBACK_ADDRESSES[0];
}

/**
 * Clear cached loopback address for a port (used on connection errors
 * to force re-probing on next request).
 */
export function clearLoopbackCache(port: number): void {
  loopbackCache.delete(port);
}

type ProxyKind = 'auth-proxy' | 'multiplex-auth-proxy';

interface AccessLogContext {
  startTime: bigint;
  req: http.IncomingMessage;
  proxy: ProxyKind;
  taskId: string;
  targetPort?: number;
  portName?: string;
  skipAuth?: boolean;
  upstreamStatusCode?: number;
  upstreamError?: string;
  upstreamTarget?: string;
  clientError?: string;
  outcome?: string;
  logged?: boolean;
}

interface WsAccessLogContext {
  startTime: bigint;
  req: http.IncomingMessage;
  proxy: ProxyKind;
  taskId: string;
  targetPort?: number;
  portName?: string;
  skipAuth?: boolean;
  upstreamTarget?: string;
  routeKind?: 'direct' | 'wildcard' | 'subdomain_rewrite';
  effectiveForwardedHost?: string;
  originHost?: string;
  logged?: boolean;
}

function getHeaderValue(
  headers: http.IncomingHttpHeaders,
  key: string,
): string | undefined {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function getOriginHost(
  origin: string | string[] | undefined,
): string | undefined {
  if (!origin) return undefined;
  const rawOrigin = Array.isArray(origin) ? origin[0] : origin;
  if (!rawOrigin) return undefined;
  try {
    return new URL(rawOrigin).host;
  } catch {
    return undefined;
  }
}

function writeProxyAccessLog(fields: Record<string, unknown>): void {
  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...fields,
    }) + '\n';

  void appendFile(PROXY_ACCESS_LOG_PATH, line).catch((error) => {
    captureWorkerException(error, {
      filePath: PROXY_ACCESS_LOG_PATH,
      stage: 'authProxy.writeAccessLog',
    });
    console.error(
      `[auth-proxy] Failed to write access log: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function createHttpAccessLog(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fields: {
    proxy: ProxyKind;
    taskId: string;
    targetPort?: number;
    portName?: string;
    skipAuth?: boolean;
  },
): AccessLogContext {
  const ctx: AccessLogContext = {
    startTime: process.hrtime.bigint(),
    req,
    ...fields,
  };

  res.on('finish', () => {
    emitHttpAccessLog(ctx, res);
  });

  res.on('close', () => {
    if (!res.writableFinished) {
      ctx.clientError = 'connection_closed';
      emitHttpAccessLog(ctx, res);
    }
  });

  return ctx;
}

function emitHttpAccessLog(
  ctx: AccessLogContext,
  res: http.ServerResponse,
): void {
  if (ctx.logged) return;
  ctx.logged = true;

  const durationMs = Number(process.hrtime.bigint() - ctx.startTime) / 1e6;

  writeProxyAccessLog({
    type: 'access',
    proxy: ctx.proxy,
    taskId: ctx.taskId,
    method: ctx.req.method,
    path: ctx.req.url,
    host: getHeaderValue(ctx.req.headers, 'host') || 'unknown',
    requestId: getHeaderValue(ctx.req.headers, 'x-request-id'),
    traceparent: getHeaderValue(ctx.req.headers, 'traceparent'),
    flyRequestId: getHeaderValue(ctx.req.headers, 'fly-request-id'),
    statusCode: res.statusCode,
    clientError: ctx.clientError,
    upstreamStatusCode: ctx.upstreamStatusCode,
    upstreamError: ctx.upstreamError,
    upstreamTarget: ctx.upstreamTarget,
    durationMs: Math.round(durationMs),
    outcome: ctx.outcome || 'unknown',
    portName: ctx.portName,
    targetPort: ctx.targetPort,
    skipAuth: ctx.skipAuth,
  });
}

function createWsAccessLog(
  req: http.IncomingMessage,
  fields: {
    proxy: ProxyKind;
    taskId: string;
    targetPort?: number;
    portName?: string;
    skipAuth?: boolean;
  },
): WsAccessLogContext {
  return {
    startTime: process.hrtime.bigint(),
    req,
    ...fields,
  };
}

function emitWsAccessLog(
  ctx: WsAccessLogContext,
  fields: {
    outcome: string;
    statusCode?: number;
    upstreamTarget?: string;
    upstreamError?: string;
  },
): void {
  if (ctx.logged) return;
  ctx.logged = true;

  const durationMs = Number(process.hrtime.bigint() - ctx.startTime) / 1e6;

  writeProxyAccessLog({
    type: 'ws_access',
    proxy: ctx.proxy,
    taskId: ctx.taskId,
    method: ctx.req.method,
    path: ctx.req.url,
    host: getHeaderValue(ctx.req.headers, 'host') || 'unknown',
    requestId: getHeaderValue(ctx.req.headers, 'x-request-id'),
    traceparent: getHeaderValue(ctx.req.headers, 'traceparent'),
    flyRequestId: getHeaderValue(ctx.req.headers, 'fly-request-id'),
    statusCode: fields.statusCode,
    upstreamTarget: fields.upstreamTarget,
    upstreamError: fields.upstreamError,
    durationMs: Math.round(durationMs),
    outcome: fields.outcome,
    portName: ctx.portName,
    targetPort: ctx.targetPort,
    skipAuth: ctx.skipAuth,
    routeKind: ctx.routeKind,
    effectiveForwardedHost: ctx.effectiveForwardedHost,
    originHost: ctx.originHost,
  });
}

// Generated taskId format: fixed 13-char lowercase base36
const TASK_ID_REGEX = /^[0-9a-z]{13}$/;

/**
 * Extracts port name from x-roomote-forwarded-host header.
 * Format: {taskId}-{portSlug}.domain
 *
 * The port slug is everything after the task ID (13-char base36).
 * Port slugs in URLs use lowercase with hyphens (e.g., "my-app"),
 * which are then converted to uppercase with underscores for storage keys (e.g., "MY_APP").
 *
 * @example extractPortNameFromHost('20imtw24sm6hv-web.preview.roomote.run') => 'WEB'
 * @example extractPortNameFromHost('20imtw24sm6hv-my-app.preview.roomote.run') => 'MY_APP'
 */
export function extractPortNameFromHost(host: string): string | null {
  // Extract subdomain (everything before the first dot)
  const dotIndex = host.indexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  const subdomain = host.substring(0, dotIndex);
  const firstHyphen = subdomain.indexOf('-');

  if (firstHyphen >= 0) {
    const potentialTaskId = subdomain.substring(0, firstHyphen);

    if (TASK_ID_REGEX.test(potentialTaskId)) {
      const portSlug = subdomain.substring(firstHyphen + 1);

      if (portSlug) {
        return slugToPortKey(portSlug);
      }
    }
  }

  return null;
}

function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce(
    (acc, cookie) => {
      const [name, ...valueParts] = cookie.trim().split('=');
      if (name) acc[name] = valueParts.join('=');
      return acc;
    },
    {} as Record<string, string>,
  );
}

function validateToken(token: string, publicKey: string): boolean {
  try {
    jwt.verify(token, publicKey, {
      algorithms: ['ES256'],
      clockTolerance: 60,
      issuer: ISSUER,
    });
    return true;
  } catch (error) {
    console.log(
      `[auth-proxy] Token validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function filterAuthCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string {
  if (!cookieHeader) return '';
  return cookieHeader
    .split(';')
    .filter((c) => !c.trim().startsWith(`${cookieName}=`))
    .join('; ')
    .trim();
}

function hasAuthBypassCredential(params: {
  headers: http.IncomingHttpHeaders;
  authBypassHeaderName: string;
  authBypassHeaderValue?: string;
}): boolean {
  const { headers, authBypassHeaderName, authBypassHeaderValue } = params;
  if (!authBypassHeaderValue) {
    return false;
  }

  const headerVal = getHeaderValue(headers, authBypassHeaderName);
  const bypassCookies = parseCookies(headers.cookie);
  const cookieVal = bypassCookies[authBypassHeaderName];

  return (
    headerVal === authBypassHeaderValue || cookieVal === authBypassHeaderValue
  );
}

/**
 * Return a 401 response for HTTP requests.
 * Navigation requests get an HTML page; API requests get JSON.
 */
function send401(req: http.IncomingMessage, res: http.ServerResponse): void {
  const accept = req.headers.accept || '';
  const secFetchMode = req.headers['sec-fetch-mode'];
  const isNavigation =
    secFetchMode === 'navigate' ||
    secFetchMode === 'nested-navigate' ||
    (!secFetchMode && accept.includes('text/html'));

  if (isNavigation) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html><head><title>Authentication Required</title></head>' +
        '<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">' +
        '<div style="text-align:center;max-width:480px;padding:2rem">' +
        '<h1>Authentication Required</h1>' +
        `<p>Please access this preview through your ${PRODUCT_NAME} dashboard.</p>` +
        '</div></body></html>',
    );
  } else {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
        message: `Please access this preview through your ${PRODUCT_NAME} dashboard.`,
      }),
    );
  }
}

/**
 * Start the auth proxy server (validate-only mode).
 * Validates the preview_auth cookie but never redirects.
 * Returns 401 on auth failure for both HTTP and WebSocket.
 *
 * Returns a promise that resolves when the server is listening.
 */
export function startAuthProxy(config: {
  /** Port to listen on - externally exposed */
  listenPort: number;
  /** Port the internal target service is running on */
  targetPort: number;
  /** ES256 public key for JWT validation - base64 encoded */
  publicKey: string;
  /** Task ID for this worker - used for logging/diagnostics */
  taskId: string;
  /** Cookie max age in seconds */
  cookieMaxAge?: number;
  /**
   * Skip authentication and proxy directly.
   * Used for port-proxy-service where preview-proxy has already validated auth.
   */
  skipAuth?: boolean;
  /**
   * Trusted bypass value forwarded by preview-proxy after it already validated
   * browser access for this task run.
   */
  authBypassHeaderValue?: string;
  /**
   * Custom header name for the trusted auth bypass channel.
   */
  authBypassHeaderName?: string;
  /**
   * Name of the auth cookie. Defaults to 'preview_auth'.
   * Configurable for nested proxy support where inner proxies use a different cookie name.
   */
  authCookieName?: string;
}): Promise<http.Server> {
  const {
    listenPort,
    targetPort,
    publicKey,
    taskId,
    cookieMaxAge: _cookieMaxAge = 3600,
    skipAuth = false,
    authBypassHeaderValue,
    authBypassHeaderName = 'x-bypass-roomote-auth',
    authCookieName = DEFAULT_COOKIE_NAME,
  } = config;

  const decodedPublicKey = skipAuth
    ? ''
    : Buffer.from(publicKey, 'base64').toString('utf-8');

  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${targetPort}`,
    ws: true,
  });
  const accessLogs = new WeakMap<http.IncomingMessage, AccessLogContext>();
  const wsAccessLogs = new WeakMap<http.IncomingMessage, WsAccessLogContext>();

  proxy.on(
    'error',
    (
      err: Error,
      req: http.IncomingMessage,
      res: http.ServerResponse | Socket,
    ) => {
      captureWorkerException(err, {
        stage: 'authProxy.proxy.error',
        targetPort,
        taskId,
      });
      console.error('[auth-proxy] Proxy error:', err.message);

      const accessLog = accessLogs.get(req);
      if (accessLog) {
        accessLog.upstreamError = err.message;
        accessLog.outcome = 'upstream_error';
      }

      const wsAccessLog = wsAccessLogs.get(req);
      if (wsAccessLog) {
        emitWsAccessLog(wsAccessLog, {
          outcome: 'upstream_error',
          upstreamTarget: wsAccessLog.upstreamTarget,
          upstreamError: err.message,
        });
      }

      if (res && 'writeHead' in res) {
        (res as http.ServerResponse).writeHead(502, {
          'Content-Type': 'text/plain',
        });
        (res as http.ServerResponse).end('Bad Gateway - target not responding');
      }
    },
  );

  proxy.on('proxyRes', (proxyRes, req) => {
    const accessLog = accessLogs.get(req);
    if (!accessLog) return;

    accessLog.upstreamStatusCode = proxyRes.statusCode;
    accessLog.outcome = 'proxied';
  });

  proxy.on(
    'proxyReq',
    (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
      // When skipAuth is true, forward all cookies (already validated by preview-proxy)
      // When skipAuth is false, filter out auth cookie
      if (!skipAuth) {
        const filtered = filterAuthCookie(req.headers.cookie, authCookieName);
        const withoutBypass = filterAuthCookie(filtered, authBypassHeaderName);
        if (withoutBypass) {
          proxyReq.setHeader('cookie', withoutBypass);
        } else {
          proxyReq.removeHeader('cookie');
        }

        proxyReq.removeHeader(authBypassHeaderName);
      }

      // Normalize x-forwarded-* headers by preferring x-roomote-forwarded-* values from preview-proxy.
      // This ensures the target service sees the real external host/protocol,
      // not Vercel sandbox internal values that may be in x-forwarded-* headers.
      const roomoteHost = req.headers['x-roomote-forwarded-host'] as
        | string
        | undefined;
      const roomoteProto = req.headers['x-roomote-forwarded-proto'] as
        | string
        | undefined;

      if (roomoteHost) {
        proxyReq.setHeader('x-forwarded-host', roomoteHost);
      }
      if (roomoteProto) {
        proxyReq.setHeader('x-forwarded-proto', roomoteProto);
      }

      // Remove x-roomote-* headers - they were only for this proxy layer
      proxyReq.removeHeader('x-roomote-forwarded-host');
      proxyReq.removeHeader('x-roomote-forwarded-proto');
    },
  );

  proxy.on(
    'proxyReqWs',
    (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
      const wsAccessLog = wsAccessLogs.get(req);
      if (!wsAccessLog) return;

      proxyReq.once('upgrade', () => {
        emitWsAccessLog(wsAccessLog, {
          outcome: 'proxied',
          statusCode: 101,
          upstreamTarget: wsAccessLog.upstreamTarget,
        });
      });

      proxyReq.once('response', (proxyRes) => {
        if (proxyRes.statusCode === 101) return;
        emitWsAccessLog(wsAccessLog, {
          outcome: 'upstream_rejected',
          statusCode: proxyRes.statusCode,
          upstreamTarget: wsAccessLog.upstreamTarget,
        });
      });
    },
  );

  const server = http.createServer((req, res) => {
    const accessLog = createHttpAccessLog(req, res, {
      proxy: 'auth-proxy',
      taskId,
      targetPort,
      skipAuth,
    });
    accessLogs.set(req, accessLog);

    // When skipAuth is true, proxy all requests directly without auth check
    if (skipAuth) {
      accessLog.outcome = 'proxied';
      proxy.web(req, res);
      return;
    }

    if (
      hasAuthBypassCredential({
        headers: req.headers,
        authBypassHeaderName,
        authBypassHeaderValue,
      })
    ) {
      accessLog.skipAuth = true;
      accessLog.outcome = 'proxied';
      proxy.web(req, res);
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[authCookieName];
    if (token && validateToken(token, decodedPublicKey)) {
      accessLog.outcome = 'proxied';
      proxy.web(req, res);
      return;
    }

    // No valid token - return 401
    accessLog.outcome = 'auth_required';
    send401(req, res);
  });

  // Handle WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    const wsAccessLog = createWsAccessLog(req, {
      proxy: 'auth-proxy',
      taskId,
      targetPort,
      skipAuth,
    });

    // When skipAuth is true, proxy WebSocket directly without auth check
    if (skipAuth) {
      wsAccessLog.upstreamTarget = `http://127.0.0.1:${targetPort}`;
      wsAccessLogs.set(req, wsAccessLog);
      proxy.ws(req, socket, head);
      return;
    }

    if (
      hasAuthBypassCredential({
        headers: req.headers,
        authBypassHeaderName,
        authBypassHeaderValue,
      })
    ) {
      wsAccessLog.skipAuth = true;
      delete req.headers[authBypassHeaderName];
      const filteredCookie = filterAuthCookie(
        req.headers.cookie,
        authBypassHeaderName,
      );
      if (filteredCookie) {
        req.headers.cookie = filteredCookie;
      } else {
        delete req.headers.cookie;
      }
      wsAccessLog.upstreamTarget = `http://127.0.0.1:${targetPort}`;
      wsAccessLogs.set(req, wsAccessLog);
      proxy.ws(req, socket, head);
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[authCookieName];

    if (!token || !validateToken(token, decodedPublicKey)) {
      // WebSockets can't redirect - return 401
      emitWsAccessLog(wsAccessLog, {
        outcome: 'auth_required',
        statusCode: 401,
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\n');
      socket.write('Content-Type: text/plain\r\n\r\n');
      socket.write('Authentication required. Please refresh the page.');
      socket.destroy();
      return;
    }

    wsAccessLog.upstreamTarget = `http://127.0.0.1:${targetPort}`;
    wsAccessLogs.set(req, wsAccessLog);
    proxy.ws(req, socket, head);
  });

  return new Promise((resolve, reject) => {
    server.listen(listenPort, '0.0.0.0', () => {
      const mode = skipAuth ? 'passthrough' : 'validate-only';
      console.log(
        `[auth-proxy] Listening on :${listenPort} -> :${targetPort} (mode: ${mode}, taskId: ${taskId})`,
      );
      resolve(server);
    });
    server.on('error', reject);
  });
}

/**
 * Start a multiplexing auth proxy server that routes to different target ports
 * based on the x-roomote-forwarded-host header.
 *
 * Operates in validate-only mode: validates the preview_auth cookie but never
 * redirects. Returns 401 on auth failure for both HTTP and WebSocket.
 *
 * All proxied application ports share this single exposed port, with routing
 * determined by the port name extracted from the original host header.
 * This allows unlimited proxied ports while only consuming one sandbox port slot.
 *
 * Returns a promise that resolves when the server is listening.
 */
export function startMultiplexAuthProxy(config: {
  /** Port to listen on - externally exposed */
  listenPort: number;
  /** Map of port names (uppercase) to target ports */
  portMapping: Record<string, number>;
  /** ES256 public key for JWT validation - base64 encoded */
  publicKey: string;
  /** Task ID for this worker - used for logging/diagnostics */
  taskId: string;
  /** Cookie max age in seconds */
  cookieMaxAge?: number;
  /**
   * Set of port names that should skip authentication.
   * Ports in this set will be publicly accessible without a preview_auth cookie.
   */
  unauthenticatedPorts?: Set<string>;
  /**
   * Subdomain mapping for named ports.
   * Maps port name (e.g., 'WEB') to subdomain (e.g., 'admin').
   * When set, the proxy rewrites the Host header to `{subdomain}.localhost:{appPort}`
   * so frameworks like Rails see the correct subdomain for routing.
   */
  subdomains?: Record<string, string>;
  /**
   * Set of port names that accept wildcard subdomain prefixes.
   * When the extracted port name doesn't match any known port, check if it
   * ends with a port slug from this set. Used for nested preview-proxy routing.
   */
  wildcardPrefixPorts?: Set<string>;
  /**
   * Name of the auth cookie. Defaults to 'preview_auth'.
   * Configurable for nested proxy support where inner proxies use a different cookie name.
   */
  authCookieName?: string;
  /**
   * Per-port path prefixes that bypass authentication.
   * Maps port name (uppercase) to an array of path prefixes.
   * Requests whose pathname starts with any listed prefix skip auth.
   * @example { "API": ["/webhooks", "/health"] }
   */
  authBypassPaths?: Record<string, string[]>;
  /**
   * Value that must appear in the bypass header to skip authentication.
   * When set, requests with the correct header value bypass auth entirely.
   */
  authBypassHeaderValue?: string;
  /**
   * Name of the bypass header. Defaults to 'x-bypass-roomote-auth'.
   * Configurable for nested Roomote stacks where each layer uses a different header name.
   */
  authBypassHeaderName?: string;
}): Promise<http.Server> {
  const {
    listenPort,
    portMapping,
    publicKey,
    taskId,
    cookieMaxAge: _cookieMaxAge = 3600,
    unauthenticatedPorts,
    subdomains,
    wildcardPrefixPorts,
    authCookieName = DEFAULT_COOKIE_NAME,
    authBypassPaths,
    authBypassHeaderValue,
    authBypassHeaderName = 'x-bypass-roomote-auth',
  } = config;

  const decodedPublicKey = Buffer.from(publicKey, 'base64').toString('utf-8');

  // Per-request metadata, avoids monkey-patching properties onto IncomingMessage.
  interface RequestMetadata {
    isWildcardRoute?: boolean;
    originalOrigin?: string;
    rewrittenHost?: string;
  }
  const reqMeta = new WeakMap<http.IncomingMessage, RequestMetadata>();
  const accessLogs = new WeakMap<http.IncomingMessage, AccessLogContext>();
  const wsAccessLogs = new WeakMap<http.IncomingMessage, WsAccessLogContext>();

  // Create a single proxy instance - target will be set per-request
  const proxy = httpProxy.createProxyServer({ ws: true });

  proxy.on(
    'error',
    (
      err: Error,
      req: http.IncomingMessage,
      res: http.ServerResponse | Socket,
    ) => {
      captureWorkerException(err, {
        stage: 'multiplexAuthProxy.proxy.error',
        taskId,
      });
      console.error('[multiplex-auth-proxy] Proxy error:', err.message);

      const accessLog = accessLogs.get(req);
      if (accessLog) {
        accessLog.upstreamError = err.message;
        accessLog.outcome = 'upstream_error';
      }

      const wsAccessLog = wsAccessLogs.get(req);
      if (wsAccessLog) {
        emitWsAccessLog(wsAccessLog, {
          outcome: 'upstream_error',
          upstreamTarget: wsAccessLog.upstreamTarget,
          upstreamError: err.message,
        });
      }

      // On ECONNREFUSED, clear the loopback cache so next request re-probes.
      // The service may have restarted on a different address (IPv4 vs IPv6).
      if (
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      ) {
        const match = err.message.match(/:(\d+)$/);
        if (match) {
          const port = parseInt(match[1]!, 10);
          clearLoopbackCache(port);
        }
      }

      if (res && 'writeHead' in res) {
        (res as http.ServerResponse).writeHead(502, {
          'Content-Type': 'text/plain',
        });
        (res as http.ServerResponse).end('Bad Gateway - target not responding');
      }
    },
  );

  proxy.on(
    'proxyReq',
    (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
      // For non-wildcard routes, strip the auth cookie before forwarding.
      // For wildcard nested routes, preserve it so the inner preview-proxy
      // can validate auth for the inner target.
      const meta = reqMeta.get(req);
      let filtered = req.headers.cookie;
      if (!meta?.isWildcardRoute) {
        filtered = filterAuthCookie(filtered, authCookieName);
      }

      // Always strip the bypass cookie before forwarding to upstream apps.
      filtered = filterAuthCookie(filtered, authBypassHeaderName);
      if (filtered) {
        proxyReq.setHeader('cookie', filtered);
      } else {
        proxyReq.removeHeader('cookie');
      }

      // Normalize x-forwarded-* headers by preferring x-roomote-forwarded-* values.
      // Subdomain rewriting (if configured) has already modified req.headers.host
      // and req.headers['x-forwarded-host'] before proxy.web() was called.
      const roomoteHost = req.headers['x-roomote-forwarded-host'] as
        | string
        | undefined;
      const roomotePublicHost = req.headers['x-roomote-public-host'] as
        | string
        | undefined;
      const roomoteProto = req.headers['x-roomote-forwarded-proto'] as
        | string
        | undefined;

      // Prefer the original public host when provided by preview-proxy.
      // This keeps canonical redirect URLs stable in nested preview topologies.
      const forwardedHost = roomotePublicHost || roomoteHost;
      if (forwardedHost) {
        // Only set x-forwarded-host here if subdomain rewriting hasn't
        // already set it (indicated by the presence of x-roomote-subdomain-rewritten).
        if (!req.headers['x-roomote-subdomain-rewritten']) {
          proxyReq.setHeader('x-forwarded-host', forwardedHost);
        }
      }
      if (roomoteProto) {
        proxyReq.setHeader('x-forwarded-proto', roomoteProto);
      }

      // Strip the auth bypass header before forwarding to the app.
      // Each proxy layer strips only its own configured header name.
      proxyReq.removeHeader(authBypassHeaderName);

      // Remove x-roomote-* headers - they were only for this proxy layer.
      // Exception: wildcard_prefix routes (inner preview-proxy) need
      // x-roomote-forwarded-host to read the original public hostname.
      // Reuse request metadata for x-roomote-* header stripping policy.
      if (!meta?.isWildcardRoute) {
        proxyReq.removeHeader('x-roomote-forwarded-host');
        proxyReq.removeHeader('x-roomote-forwarded-proto');
      }
      proxyReq.removeHeader('x-roomote-public-host');
      proxyReq.removeHeader('x-roomote-subdomain-rewritten');
    },
  );

  proxy.on(
    'proxyReqWs',
    (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
      const wsAccessLog = wsAccessLogs.get(req);
      if (!wsAccessLog) return;

      proxyReq.once('upgrade', () => {
        emitWsAccessLog(wsAccessLog, {
          outcome: 'proxied',
          statusCode: 101,
          upstreamTarget: wsAccessLog.upstreamTarget,
        });
      });
    },
  );

  // Rewrite Location headers in redirect responses when subdomain rewriting is active.
  // The app builds redirect URLs using the rewritten Host (e.g., admin.localhost:3000),
  // but the browser needs the original preview URL to follow the redirect.
  proxy.on(
    'proxyRes',
    (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
      const accessLog = accessLogs.get(req);
      if (accessLog) {
        accessLog.upstreamStatusCode = proxyRes.statusCode;
        accessLog.outcome = 'proxied';
      }

      const meta = reqMeta.get(req);
      const originalOrigin = meta?.originalOrigin;
      const rewrittenHost = meta?.rewrittenHost;
      if (!originalOrigin || !rewrittenHost) return;

      const location = proxyRes.headers['location'];
      if (typeof location === 'string' && location.includes(rewrittenHost)) {
        const newLocation = location.replace(
          new RegExp(
            `https?://${rewrittenHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          ),
          originalOrigin,
        );
        proxyRes.headers['location'] = newLocation;
        console.log(
          `[multiplex-auth-proxy] Rewrote Location: ${location} -> ${newLocation}`,
        );
      }
    },
  );

  /**
   * Resolve target port from x-roomote-forwarded-host header.
   * Returns the target port number or null if routing fails.
   */
  function resolveTargetPort(req: http.IncomingMessage): {
    port: number;
    portName: string;
    skipAuth: boolean;
    isWildcardRoute: boolean;
  } | null {
    const forwardedHost = req.headers['x-roomote-forwarded-host'] as
      | string
      | undefined;

    if (!forwardedHost) {
      console.warn(
        '[multiplex-auth-proxy] Missing x-roomote-forwarded-host header',
      );

      return null;
    }

    const portName = extractPortNameFromHost(forwardedHost);

    if (!portName) {
      console.warn(
        `[multiplex-auth-proxy] Could not extract port name from host: ${forwardedHost}`,
      );

      return null;
    }

    let resolvedPortName = portName;
    let targetPort = portMapping[portName];

    // If exact match fails, try wildcard prefix matching.
    // For nested URLs, the extracted port name will be a compound like
    // "WEB-R4NJE6W8AB-PREVIEW" — check if it ends with any wildcard port slug.
    // Note: the exact-match check above runs first, so `endsWith` below cannot
    // produce a false positive for ports that exist directly in portMapping.
    if (targetPort === undefined && wildcardPrefixPorts) {
      for (const wcPort of wildcardPrefixPorts) {
        // Port slug in the URL is lowercase with hyphens, but portMapping keys
        // are uppercase with underscores. The extracted portName is already uppercase.
        if (portName.endsWith(`_${wcPort}`) || portName === wcPort) {
          targetPort = portMapping[wcPort];

          if (targetPort !== undefined) {
            resolvedPortName = wcPort;
            break;
          }
        }
      }
    }

    if (targetPort === undefined) {
      console.warn(
        `[multiplex-auth-proxy] Unknown port name: ${portName} (available: ${Object.keys(portMapping).join(', ')})`,
      );

      return null;
    }

    const skipAuth = unauthenticatedPorts?.has(resolvedPortName) ?? false;
    const isWildcardRoute = resolvedPortName !== portName;

    return {
      port: targetPort,
      portName: resolvedPortName,
      skipAuth,
      isWildcardRoute,
    };
  }

  const server = http.createServer((req, res) => {
    const accessLog = createHttpAccessLog(req, res, {
      proxy: 'multiplex-auth-proxy',
      taskId,
    });

    accessLogs.set(req, accessLog);

    // Resolve target port from forwarded host first
    const target = resolveTargetPort(req);

    if (!target) {
      accessLog.outcome = 'route_not_found';
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: Could not determine target port');
      return;
    }

    accessLog.targetPort = target.port;
    accessLog.portName = target.portName;
    accessLog.skipAuth = target.skipAuth;

    // Check path-prefix bypass
    if (!target.skipAuth && authBypassPaths) {
      const bypassPaths = authBypassPaths[target.portName];

      if (bypassPaths && req.url) {
        const pathname = new URL(req.url, 'http://localhost').pathname;

        if (bypassPaths.some((prefix) => pathname.startsWith(prefix))) {
          target.skipAuth = true;
          accessLog.skipAuth = true;
        }
      }
    }

    // Check header or cookie bypass
    if (!target.skipAuth && authBypassHeaderValue) {
      const headerVal = req.headers[authBypassHeaderName];
      const bypassCookies = parseCookies(req.headers.cookie);
      const cookieVal = bypassCookies[authBypassHeaderName];

      if (
        headerVal === authBypassHeaderValue ||
        cookieVal === authBypassHeaderValue
      ) {
        target.skipAuth = true;
        accessLog.skipAuth = true;
      }
    }

    // Check if this port requires auth (validate-only, no redirects)
    if (!target.skipAuth) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[authCookieName];

      if (!token || !validateToken(token, decodedPublicKey)) {
        // No valid token - return 401 (no redirect)
        accessLog.outcome = 'auth_required';
        send401(req, res);
        return;
      }
    }

    // For wildcard_prefix routes, preserve x-roomote-forwarded-host so the inner
    // preview-proxy can read the original hostname (it needs this to parse the
    // nested URL correctly, since http-proxy rewrites the host header to a
    // loopback address).
    if (target.isWildcardRoute) {
      const meta = reqMeta.get(req) ?? {};
      meta.isWildcardRoute = true;
      reqMeta.set(req, meta);
    }

    // Rewrite Host and X-Forwarded-Host for subdomain-based routing.
    // Must be done BEFORE proxy.web() so http-proxy picks up the modified headers.
    // Frameworks like Rails check X-Forwarded-Host when behind a proxy to determine
    // the request host for subdomain routing.
    if (subdomains) {
      const subdomain = subdomains[target.portName];

      if (subdomain) {
        const roomoteHost = req.headers['x-roomote-forwarded-host'] as string;

        const roomoteProto =
          (req.headers['x-roomote-forwarded-proto'] as string) || 'https';

        const rewrittenHost = `${subdomain}.localhost:${target.port}`;

        console.log(
          `[multiplex-auth-proxy] Rewriting Host for ${target.portName}: ${req.headers.host} -> ${rewrittenHost}`,
        );

        // Store original URL info for response Location rewriting
        const meta = reqMeta.get(req) ?? {};
        meta.originalOrigin = `${roomoteProto}://${roomoteHost}`;
        meta.rewrittenHost = rewrittenHost;
        reqMeta.set(req, meta);
        req.headers.host = rewrittenHost;
        req.headers['x-forwarded-host'] = rewrittenHost;

        // Rewrite Origin to match the rewritten host so frameworks like Rails
        // don't reject the request due to CSRF origin mismatch.
        if (req.headers.origin) {
          req.headers.origin = `${roomoteProto}://${rewrittenHost}`;
        }

        // Signal to proxyReq handler not to overwrite x-forwarded-host with roomoteHost
        req.headers['x-roomote-subdomain-rewritten'] = '1';
      }
    }

    // Proxy to target port - resolve loopback address (IPv4 or IPv6)
    resolveLoopback(target.port)
      .then((addr) => {
        accessLog.upstreamTarget = `http://${addr}:${target.port}`;
        accessLog.outcome = 'proxied';
        proxy.web(req, res, { target: accessLog.upstreamTarget });
      })
      .catch((err) => {
        captureWorkerException(err, {
          portName: target.portName,
          stage: 'multiplexAuthProxy.resolveLoopback.http',
          targetPort: target.port,
          taskId,
        });

        console.error(
          '[multiplex-auth-proxy] Loopback resolve error:',
          err.message,
        );

        accessLog.upstreamError =
          err instanceof Error ? err.message : String(err);
        accessLog.outcome = 'loopback_resolve_error';
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      });
  });

  // Handle WebSocket upgrade with same routing logic
  server.on('upgrade', (req, socket, head) => {
    const wsAccessLog = createWsAccessLog(req, {
      proxy: 'multiplex-auth-proxy',
      taskId,
    });

    const target = resolveTargetPort(req);

    if (!target) {
      emitWsAccessLog(wsAccessLog, {
        outcome: 'route_not_found',
        statusCode: 400,
      });

      socket.write('HTTP/1.1 400 Bad Request\r\n');
      socket.write('Content-Type: text/plain\r\n\r\n');
      socket.write('Could not determine target port');
      socket.destroy();

      return;
    }

    wsAccessLog.targetPort = target.port;
    wsAccessLog.portName = target.portName;
    wsAccessLog.skipAuth = target.skipAuth;
    wsAccessLog.routeKind = target.isWildcardRoute ? 'wildcard' : 'direct';

    // Check path-prefix bypass (WebSocket)
    if (!target.skipAuth && authBypassPaths) {
      const bypassPaths = authBypassPaths[target.portName];

      if (bypassPaths && req.url) {
        const pathname = new URL(req.url, 'http://localhost').pathname;

        if (bypassPaths.some((prefix) => pathname.startsWith(prefix))) {
          target.skipAuth = true;
          wsAccessLog.skipAuth = true;
        }
      }
    }

    // Check header or cookie bypass (WebSocket)
    if (!target.skipAuth && authBypassHeaderValue) {
      const headerVal = req.headers[authBypassHeaderName];
      const bypassCookies = parseCookies(req.headers.cookie);
      const cookieVal = bypassCookies[authBypassHeaderName];

      if (
        headerVal === authBypassHeaderValue ||
        cookieVal === authBypassHeaderValue
      ) {
        target.skipAuth = true;
        wsAccessLog.skipAuth = true;
      }
    }

    // Check auth unless port is unauthenticated (validate-only, no redirects)
    if (!target.skipAuth) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[authCookieName];

      if (!token || !validateToken(token, decodedPublicKey)) {
        emitWsAccessLog(wsAccessLog, {
          outcome: 'auth_required',
          statusCode: 401,
        });

        socket.write('HTTP/1.1 401 Unauthorized\r\n');
        socket.write('Content-Type: text/plain\r\n\r\n');
        socket.write('Authentication required. Please refresh the page.');
        socket.destroy();

        return;
      }
    }

    // Strip bypass header and cookie from WebSocket requests (proxyReq doesn't fire for WS).
    // Apply the same auth-cookie policy as HTTP:
    // - wildcard nested route: preserve auth cookie
    // - non-wildcard route: strip auth cookie
    delete req.headers[authBypassHeaderName];
    let filteredWsCookie = req.headers.cookie;

    if (!target.isWildcardRoute) {
      filteredWsCookie = filterAuthCookie(filteredWsCookie, authCookieName);
    }

    filteredWsCookie = filterAuthCookie(filteredWsCookie, authBypassHeaderName);

    if (filteredWsCookie) {
      req.headers.cookie = filteredWsCookie;
    } else {
      delete req.headers.cookie;
    }

    // Mirror x-forwarded-host behavior for WS upgrades. For non-subdomain
    // routes, this aligns strict upstream origin checks against the public host.
    // Prefer the original public host when provided, otherwise use
    // x-roomote-forwarded-host.
    const roomoteWsHost = req.headers['x-roomote-forwarded-host'] as
      | string
      | undefined;

    const roomoteWsPublicHost = req.headers['x-roomote-public-host'] as
      | string
      | undefined;

    const forwardedWsHost = roomoteWsPublicHost || roomoteWsHost;

    if (forwardedWsHost) {
      req.headers['x-forwarded-host'] = forwardedWsHost;
      wsAccessLog.effectiveForwardedHost = forwardedWsHost;
    } else {
      wsAccessLog.effectiveForwardedHost = undefined;
    }

    const wsSubdomain = subdomains?.[target.portName];

    if (!target.isWildcardRoute && !wsSubdomain && forwardedWsHost) {
      req.headers.host = forwardedWsHost;
    }

    // For non-wildcard WebSocket routes, remove x-roomote-* headers.
    // proxyReq event doesn't fire for WS upgrades so we do it here.
    // Wildcard routes preserve x-roomote-forwarded-host for the inner preview-proxy.
    if (!target.isWildcardRoute) {
      delete req.headers['x-roomote-forwarded-host'];
      delete req.headers['x-roomote-forwarded-proto'];
    }

    delete req.headers['x-roomote-public-host'];

    // Rewrite Host header for WebSocket subdomain routing.
    // proxyReq event doesn't fire for WebSocket upgrades, so set req.headers.host directly.
    if (subdomains) {
      const subdomain = subdomains[target.portName];

      if (subdomain) {
        wsAccessLog.routeKind = 'subdomain_rewrite';

        const roomoteProto =
          (req.headers['x-roomote-forwarded-proto'] as string) || 'https';

        const rewrittenHost = `${subdomain}.localhost:${target.port}`;

        console.log(
          `[multiplex-auth-proxy] Rewriting WS Host for ${target.portName}: ${rewrittenHost}`,
        );

        req.headers.host = rewrittenHost;
        req.headers['x-forwarded-host'] = rewrittenHost;

        if (req.headers.origin) {
          req.headers.origin = `${roomoteProto}://${rewrittenHost}`;
        }

        wsAccessLog.effectiveForwardedHost = rewrittenHost;
      }
    }

    wsAccessLog.originHost = getOriginHost(req.headers.origin);

    resolveLoopback(target.port)
      .then((addr) => {
        wsAccessLog.upstreamTarget = `http://${addr}:${target.port}`;
        wsAccessLogs.set(req, wsAccessLog);
        proxy.ws(req, socket, head, { target: wsAccessLog.upstreamTarget });
      })
      .catch((err) => {
        captureWorkerException(err, {
          portName: target.portName,
          stage: 'multiplexAuthProxy.resolveLoopback.ws',
          targetPort: target.port,
          taskId,
        });

        console.error(
          '[multiplex-auth-proxy] WebSocket loopback resolve error:',
          err.message,
        );

        emitWsAccessLog(wsAccessLog, {
          outcome: 'loopback_resolve_error',
          upstreamError: err instanceof Error ? err.message : String(err),
        });

        socket.destroy();
      });
  });

  return new Promise((resolve, reject) => {
    server.listen(listenPort, '0.0.0.0', () => {
      const portNames = Object.keys(portMapping).join(', ');

      const subdomainInfo = subdomains
        ? `, subdomains: ${JSON.stringify(subdomains)}`
        : '';

      console.log(
        `[multiplex-auth-proxy] Listening on :${listenPort} (ports: ${portNames}${subdomainInfo}, taskId: ${taskId})`,
      );

      resolve(server);
    });

    server.on('error', reject);
  });
}
