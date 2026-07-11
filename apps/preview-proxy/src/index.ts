import http from 'node:http';
import type { Socket } from 'node:net';

import { assertSecureBootBinding } from '@roomote/env';

import { createProxy } from './lib/proxy';
import { logger, escapeForLog } from './lib/logger';
import { createAccessLog, type AccessLogContext } from './lib/access-log';
import {
  getHeaderValue,
  resolveRequestCorrelation,
} from './lib/request-correlation';
import { runWithRequestContext } from './lib/request-context';
import { PREVIEW_WIDGET } from './lib/preview-widget';
import {
  shouldInjectScript,
  shouldHideInjectedWidget,
  injectScriptIntoResponse,
  passthroughResponse,
} from './lib/html-injector';
import { parseHostForConfig } from './lib/url-parser';

import { config } from './config';
import {
  SYSTEM_PORT_NAMES,
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
  portNameToSlug,
} from '@roomote/types';

import { handleHttpRequest } from './handlers/http';
import { handleWebSocketUpgrade } from './handlers/websocket';
import { handleAuthCallback } from './handlers/auth-callback';
import { handleResumeStatusRequest } from './handlers/resume-status';

/**
 * Pre-computed set of URL slugs for system-managed ports (e.g. "editor",
 * "sandbox-server"). The preview widget should not be injected into these
 * ports because they serve non-user content (VS Code, sandbox API, etc.).
 */
const SYSTEM_PORT_SLUGS = new Set([...SYSTEM_PORT_NAMES].map(portNameToSlug));

/**
 * Check if a set-cookie header is setting the preview_auth cookie.
 * Used to filter cookies from sandbox responses to prevent session fixation.
 *
 * NOTE: This filtering may be removed in the future when preview-proxy
 * is no longer solely responsible for auth cookie management.
 */
function isPreviewAuthSetCookie(setCookieValue: string): boolean {
  const cookieName = setCookieValue.split('=')[0]?.trim().toLowerCase();
  return cookieName === config.PREVIEW_AUTH_COOKIE_NAME.toLowerCase();
}

// Create the proxy instance
const proxy = createProxy();

// Handle proxy errors (both HTTP and WebSocket)
proxy.on('error', (err, req, res) => {
  const host = req.headers.host || 'unknown';
  logger.error({ err, host: escapeForLog(host) }, 'Proxy error');

  if (res && 'writeHead' in res) {
    // HTTP response
    const httpRes = res as http.ServerResponse;
    if (!httpRes.headersSent) {
      httpRes.writeHead(502);
      httpRes.end('Bad Gateway');
    }
  } else if (res && typeof (res as Socket).destroy === 'function') {
    // WebSocket socket - must be properly destroyed to avoid 1006 errors
    const socket = res as Socket;
    if (!socket.destroyed) {
      socket.destroy();
    }
  }
});

// Filter preview_auth set-cookie headers from sandbox responses.
// This prevents sandboxes from overwriting the auth cookie (session fixation).
// NOTE: This handler may be removed when other parties handle cookie filtering.
proxy.on('proxyRes', (proxyRes, req, res) => {
  // Populate upstream status code on the access log context
  const ctx = (req as http.IncomingMessage & { __accessLog?: AccessLogContext })
    .__accessLog;
  if (ctx) {
    ctx.upstreamStatusCode = proxyRes.statusCode;
  }

  const setCookieHeaders = proxyRes.headers['set-cookie'];
  if (setCookieHeaders) {
    const filtered = Array.isArray(setCookieHeaders)
      ? setCookieHeaders.filter((v) => !isPreviewAuthSetCookie(v))
      : isPreviewAuthSetCookie(setCookieHeaders)
        ? []
        : [setCookieHeaders];

    if (filtered.length > 0) {
      proxyRes.headers['set-cookie'] = filtered;
    } else {
      delete proxyRes.headers['set-cookie'];
    }
  }

  const roomoteRequestId = getHeaderValue(req.headers, 'x-request-id');
  if (roomoteRequestId) {
    proxyRes.headers['x-roomote-request-id'] = roomoteRequestId;
  }

  // Strip iframe-blocking headers only for actual iframe requests.
  // Sec-Fetch-Dest is browser-enforced; non-browser clients that spoof it
  // still need valid auth to access preview content.
  if (req.headers['sec-fetch-dest'] === 'iframe') {
    delete proxyRes.headers['x-frame-options'];

    const csp = proxyRes.headers['content-security-policy'];
    if (typeof csp === 'string' && csp.includes('frame-ancestors')) {
      proxyRes.headers['content-security-policy'] = csp
        .split(';')
        .filter((d) => !d.trim().startsWith('frame-ancestors'))
        .join(';')
        .trim();
      if (!proxyRes.headers['content-security-policy']) {
        delete proxyRes.headers['content-security-policy'];
      }
    }
  }

  // selfHandleResponse is enabled, so we must write the response ourselves.
  // Inject the overlay script into HTML responses; pass everything else through.
  // Skip injection for system ports (VS Code editor, sandbox server) since the
  // preview widget is only relevant for normal user previews, not internal automation sessions.
  const serverRes = res as http.ServerResponse;
  const host = req.headers.host || '';
  const parsed = parseHostForConfig(
    host,
    config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX,
  );
  const isSystemPort = parsed.isValid && SYSTEM_PORT_SLUGS.has(parsed.portName);

  if (
    !isSystemPort &&
    !shouldHideInjectedWidget(req) &&
    shouldInjectScript(proxyRes)
  ) {
    injectScriptIntoResponse(proxyRes, serverRes);
  } else {
    passthroughResponse(proxyRes, serverRes);
  }
});

// Create the HTTP server
export const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  const correlation = resolveRequestCorrelation(req);

  req.headers['x-request-id'] = correlation.requestContext.requestId;
  req.headers.traceparent = correlation.requestContext.traceparent;
  if (correlation.dropTracestate) {
    delete req.headers.tracestate;
  }

  (
    req as http.IncomingMessage & { __dropTracestate?: boolean }
  ).__dropTracestate = correlation.dropTracestate;

  res.setHeader('x-roomote-request-id', correlation.requestContext.requestId);

  await runWithRequestContext(correlation.requestContext, async () => {
    const accessLog = createAccessLog(req, res);

    (
      req as http.IncomingMessage & { __accessLog?: AccessLogContext }
    ).__accessLog = accessLog;

    logger.debug(
      {
        method: req.method,
        path: req.url,
        host: host ? escapeForLog(host) : 'unknown',
      },
      'Request received',
    );

    try {
      const url = new URL(req.url || '/', `http://${host || 'localhost'}`);

      if (url.pathname === '/health') {
        accessLog.outcome = 'health';
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }

      if (url.pathname === '/rooproxy/inject.js') {
        accessLog.outcome = 'inject_script';
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(PREVIEW_WIDGET.replace('__R_APP_URL__', config.R_APP_URL));
        return;
      }

      if (url.pathname === '/auth/callback') {
        accessLog.outcome = 'auth_callback';
        await handleAuthCallback(req, res, url, proxy, accessLog);
        return;
      }

      const resumeStatusMatch = url.pathname.match(
        /^\/rooproxy\/resume-status\/([^/]+)$/,
      );
      if (resumeStatusMatch && resumeStatusMatch[1]) {
        accessLog.outcome = 'resume_status';
        await handleResumeStatusRequest(
          req,
          res,
          decodeURIComponent(resumeStatusMatch[1]),
        );
        return;
      }

      await handleHttpRequest(req, res, proxy, accessLog);
    } catch (error) {
      accessLog.outcome = 'error';
      logger.error(
        { error, host: host ? escapeForLog(host) : 'unknown' },
        'Unhandled error',
      );
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  const correlation = resolveRequestCorrelation(req);

  req.headers['x-request-id'] = correlation.requestContext.requestId;
  req.headers.traceparent = correlation.requestContext.traceparent;
  if (correlation.dropTracestate) {
    delete req.headers.tracestate;
  }

  (
    req as http.IncomingMessage & { __dropTracestate?: boolean }
  ).__dropTracestate = correlation.dropTracestate;

  void runWithRequestContext(correlation.requestContext, () => {
    return handleWebSocketUpgrade(req, socket as Socket, head, proxy).catch(
      (error) => {
        const host = req.headers.host || 'unknown';
        logger.error(
          { error, host: escapeForLog(host) },
          'WebSocket upgrade error',
        );
        if (!socket.destroyed) {
          socket.destroy();
        }
      },
    );
  });
});

const port = parseInt(config.PORT);
const previewProxyDeployMarker = buildRoomoteDeployMarker({
  service: 'preview-proxy',
  overrides: {
    roomote_node_env: config.NODE_ENV,
  },
});

logger.info(
  previewProxyDeployMarker,
  formatRoomoteDeployMarker(previewProxyDeployMarker),
);
logger.info(
  {
    port,
    nodeEnv: config.NODE_ENV,
  },
  'Starting preview proxy server',
);

async function start() {
  // Resolve auto-generated auth keypairs before accepting traffic so
  // preview-token verification observes the resolved keys.
  const { bootstrapGeneratedAuthKeypairs } = await import('@roomote/db/server');
  await bootstrapGeneratedAuthKeypairs();
  assertSecureBootBinding();

  server.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
  });
}

start().catch((error) => {
  logger.error({ error }, 'Failed to start preview proxy server');
  process.exit(1);
});

// Export for testing
export { proxy };
