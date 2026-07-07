import zlib from 'node:zlib';
import type http from 'node:http';

import { HIDE_PREVIEW_WIDGET_COOKIE } from '@roomote/types';

const SCRIPT_TAG = '<script src="/rooproxy/inject.js"></script>';

/**
 * Check if a proxy response contains HTML that should have the overlay
 * script injected.
 */
export function shouldInjectScript(proxyRes: http.IncomingMessage): boolean {
  const contentType = proxyRes.headers['content-type'] || '';
  return contentType.includes('text/html');
}

/**
 * Returns true when the preview widget should be suppressed for a request.
 * This is used by browser automation clients so internal browser sessions
 * stay clean for screenshots and automation, while normal user previews keep the widget.
 */
export function shouldHideInjectedWidget(
  req: Pick<http.IncomingMessage, 'headers'>,
): boolean {
  const cookieHeader = req.headers.cookie;
  const cookieHeaders = Array.isArray(cookieHeader)
    ? cookieHeader
    : cookieHeader
      ? [cookieHeader]
      : [];

  return cookieHeaders.some((value) =>
    value
      .split(';')
      .map((cookie: string) => cookie.trim())
      .some((cookie: string) =>
        cookie.startsWith(`${HIDE_PREVIEW_WIDGET_COOKIE}=`),
      ),
  );
}

/**
 * Inject script tag into an HTML string. Inserts before </head> if present,
 * falls back to before </body>, and finally appends at end.
 * Skips injection if the script tag is already present (idempotency).
 */
export function injectScriptTag(html: string): string {
  if (html.includes('/rooproxy/inject.js')) {
    return html;
  }

  if (html.includes('</head>')) {
    return html.replace('</head>', SCRIPT_TAG + '</head>');
  }

  if (html.includes('</body>')) {
    return html.replace('</body>', SCRIPT_TAG + '</body>');
  }

  return html + SCRIPT_TAG;
}

/**
 * Intercept an HTML proxy response, inject the overlay script tag, and
 * write the modified response to the client. Handles gzip, brotli, and
 * deflate content-encoding transparently.
 *
 * For non-HTML responses, use {@link passthroughResponse} instead.
 */
export function injectScriptIntoResponse(
  proxyRes: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const encoding = proxyRes.headers['content-encoding'];

  // Remove content-length since we're modifying the body
  delete proxyRes.headers['content-length'];

  // Set up decompression/recompression if needed
  let readable: NodeJS.ReadableStream = proxyRes;
  let writable: NodeJS.WritableStream = res;

  if (encoding === 'gzip') {
    readable = proxyRes.pipe(zlib.createGunzip());
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    writable = gzip;
  } else if (encoding === 'br') {
    readable = proxyRes.pipe(zlib.createBrotliDecompress());
    const br = zlib.createBrotliCompress();
    br.pipe(res);
    writable = br;
  } else if (encoding === 'deflate') {
    readable = proxyRes.pipe(zlib.createInflate());
    const deflate = zlib.createDeflate();
    deflate.pipe(res);
    writable = deflate;
  }

  // Buffer the decompressed body, inject, then write.
  // Headers are deferred so the error handler can still send a 502 status.
  const chunks: Buffer[] = [];
  readable.on('data', (chunk: Buffer | string) =>
    chunks.push(Buffer.from(chunk)),
  );
  readable.on('end', () => {
    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
    }
    const html = Buffer.concat(chunks).toString('utf-8');
    const injected = injectScriptTag(html);
    writable.end(injected);
  });
  readable.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502);
    }
    if (!res.writableEnded) {
      res.end('Bad Gateway');
    }
    const readableWithDestroy = readable as NodeJS.ReadableStream & {
      destroy?: (err?: Error) => void;
    };
    readableWithDestroy.destroy?.(error instanceof Error ? error : undefined);
  });
}

/**
 * Pass a non-HTML proxy response through to the client unchanged.
 * Used when selfHandleResponse is enabled but no injection is needed.
 */
export function passthroughResponse(
  proxyRes: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
  proxyRes.pipe(res);
}
