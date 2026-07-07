import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { logger, escapeForLog } from './logger';

/**
 * Create a proxy server instance with WebSocket support.
 */
export function createProxy(): httpProxy {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    // Disable xfwd - we'll manage x-forwarded-* headers manually
    // http-proxy adds ",ws" to x-forwarded-proto which confuses some servers
    xfwd: false,
    // Ensure secure connections for HTTPS targets
    secure: process.env.NODE_ENV === 'production',
    // Let us handle the response so we can inject scripts into HTML pages
    selfHandleResponse: true,
  });

  // Handle WebSocket proxy requests
  proxy.on('proxyReqWs', (proxyReq, req, socket) => {
    // Fix: Ensure x-forwarded-proto doesn't have ",ws" suffix
    // Some servers (like Vercel) don't recognize this non-standard format
    const xfp = proxyReq.getHeader('x-forwarded-proto');
    if (typeof xfp === 'string' && xfp.includes(',ws')) {
      proxyReq.setHeader('x-forwarded-proto', xfp.replace(',ws', ''));
    }

    // Handle non-101 responses (auth failures, redirects, etc.)
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode !== 101) {
        logger.warn(
          {
            statusCode: proxyRes.statusCode,
            host: escapeForLog(req.headers.host || 'unknown'),
          },
          'WebSocket upgrade failed',
        );
        const sock = socket as Socket;
        if (!sock.destroyed) {
          sock.write(
            `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || 'Upgrade Failed'}\r\n\r\n`,
          );
          sock.destroy();
        }
      }
    });
  });

  return proxy;
}

/**
 * Proxy an HTTP request to a target URL.
 * All async operations must be completed before calling this function.
 */
export function proxyRequest(
  proxy: httpProxy,
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  onError?: (err: Error) => void,
): void {
  proxy.web(req, res, { target }, (err) => {
    if (err) {
      logger.error(
        { err, target: escapeForLog(target) },
        'Proxy request error',
      );
      onError?.(err);
    }
  });
}

/**
 * Proxy a WebSocket connection to a target URL.
 * All async operations must be completed before calling this function.
 */
export function proxyWebSocket(
  proxy: httpProxy,
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: string,
): void {
  // Handle socket errors to prevent unhandled exceptions
  socket.on('error', (err) => {
    logger.error(
      { err, target: escapeForLog(target) },
      'WebSocket socket error',
    );
  });

  proxy.ws(req, socket, head, { target });
}
