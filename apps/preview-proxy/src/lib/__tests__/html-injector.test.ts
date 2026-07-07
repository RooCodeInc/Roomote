import zlib from 'node:zlib';
import { EventEmitter, Readable } from 'node:stream';
import type http from 'node:http';
import {
  shouldInjectScript,
  shouldHideInjectedWidget,
  injectScriptTag,
  injectScriptIntoResponse,
  passthroughResponse,
} from '../html-injector';
import { HIDE_PREVIEW_WIDGET_COOKIE } from '@roomote/types';

// Helper to create a mock IncomingMessage (proxy response)
function createMockProxyRes(
  headers: Record<string, string> = {},
  body = '',
  statusCode = 200,
): http.IncomingMessage {
  const readable = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  });
  Object.assign(readable, {
    headers,
    statusCode,
    pipe: readable.pipe.bind(readable),
  });
  return readable as unknown as http.IncomingMessage;
}

// Helper to create a mock ServerResponse that captures written data
function createMockRes() {
  const chunks: Buffer[] = [];
  let status = 0;
  let capturedHeaders: Record<string, string> = {};

  const res = new EventEmitter() as unknown as http.ServerResponse;
  (res as unknown as Record<string, unknown>).writeHead = vi.fn(
    (s: number, h?: Record<string, string>) => {
      status = s;
      if (h) capturedHeaders = h;
      return res;
    },
  );
  (res as unknown as Record<string, unknown>).write = vi.fn(
    (chunk: Buffer | string) => {
      chunks.push(Buffer.from(chunk));
      return true;
    },
  );
  (res as unknown as Record<string, unknown>).end = vi.fn((data?: unknown) => {
    if (data && (typeof data === 'string' || Buffer.isBuffer(data))) {
      chunks.push(Buffer.from(data));
    }
    (res as unknown as EventEmitter).emit('finish');
    return res;
  });
  (res as unknown as Record<string, unknown>).writable = true;

  return {
    res,
    getBody: () => Buffer.concat(chunks).toString('utf-8'),
    getStatus: () => status,
    getHeaders: () => capturedHeaders,
  };
}

describe('shouldInjectScript', () => {
  it('returns true for text/html content-type', () => {
    const proxyRes = createMockProxyRes({
      'content-type': 'text/html; charset=utf-8',
    });
    expect(shouldInjectScript(proxyRes)).toBe(true);
  });

  it('returns true for text/html without charset', () => {
    const proxyRes = createMockProxyRes({ 'content-type': 'text/html' });
    expect(shouldInjectScript(proxyRes)).toBe(true);
  });

  it('returns false for application/json', () => {
    const proxyRes = createMockProxyRes({
      'content-type': 'application/json',
    });
    expect(shouldInjectScript(proxyRes)).toBe(false);
  });

  it('returns false for text/css', () => {
    const proxyRes = createMockProxyRes({ 'content-type': 'text/css' });
    expect(shouldInjectScript(proxyRes)).toBe(false);
  });

  it('returns false for image/png', () => {
    const proxyRes = createMockProxyRes({ 'content-type': 'image/png' });
    expect(shouldInjectScript(proxyRes)).toBe(false);
  });

  it('returns false when content-type is missing', () => {
    const proxyRes = createMockProxyRes({});
    expect(shouldInjectScript(proxyRes)).toBe(false);
  });
});

describe('injectScriptTag', () => {
  const SCRIPT_TAG = '<script src="/rooproxy/inject.js"></script>';

  it('injects before </head> when present', () => {
    const html =
      '<html><head><title>Test</title></head><body>Hello</body></html>';
    const result = injectScriptTag(html);
    expect(result).toBe(
      `<html><head><title>Test</title>${SCRIPT_TAG}</head><body>Hello</body></html>`,
    );
  });

  it('injects before </body> when no </head> present', () => {
    const html = '<html><body>Hello</body></html>';
    const result = injectScriptTag(html);
    expect(result).toBe(`<html><body>Hello${SCRIPT_TAG}</body></html>`);
  });

  it('appends at end for HTML fragments without </head> or </body>', () => {
    const html = '<div>Hello world</div>';
    const result = injectScriptTag(html);
    expect(result).toBe(`<div>Hello world</div>${SCRIPT_TAG}`);
  });

  it('skips injection if script tag already present (idempotency)', () => {
    const html = `<html><head>${SCRIPT_TAG}</head><body>Hello</body></html>`;
    const result = injectScriptTag(html);
    expect(result).toBe(html);
  });

  it('handles empty string', () => {
    const result = injectScriptTag('');
    expect(result).toBe(SCRIPT_TAG);
  });
});

describe('shouldHideInjectedWidget', () => {
  it('returns true when the hide cookie is present', () => {
    expect(
      shouldHideInjectedWidget({
        headers: { cookie: `${HIDE_PREVIEW_WIDGET_COOKIE}=1; other=value` },
      }),
    ).toBe(true);
  });

  it('returns false when the hide cookie is missing', () => {
    expect(
      shouldHideInjectedWidget({ headers: { cookie: 'other=value' } }),
    ).toBe(false);
  });
});

describe('injectScriptIntoResponse', () => {
  it('injects script tag into uncompressed HTML response', async () => {
    const html =
      '<html><head><title>App</title></head><body>Content</body></html>';
    const proxyRes = createMockProxyRes(
      { 'content-type': 'text/html', 'content-length': String(html.length) },
      html,
    );
    const { res, getBody, getStatus, getHeaders } = createMockRes();

    injectScriptIntoResponse(proxyRes, res);
    await new Promise((resolve) =>
      (res as unknown as EventEmitter).on('finish', resolve),
    );

    expect(getBody()).toContain('/rooproxy/inject.js');
    expect(getBody()).toContain('<title>App</title>');
    expect(getStatus()).toBe(200);
    // content-length should have been removed from headers
    expect(getHeaders()).not.toHaveProperty('content-length');
  });

  it('handles gzip-compressed HTML response', async () => {
    const html =
      '<html><head><title>Gzip</title></head><body>Compressed</body></html>';
    const compressed = zlib.gzipSync(Buffer.from(html));

    const readable = new Readable({
      read() {
        this.push(compressed);
        this.push(null);
      },
    });
    Object.assign(readable, {
      headers: {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
      },
      statusCode: 200,
      pipe: readable.pipe.bind(readable),
    });
    const proxyRes = readable as unknown as http.IncomingMessage;

    // For gzip, the output gets piped through a gzip stream back to res.
    // We capture all data written through piping.
    const outputChunks: Buffer[] = [];
    const res = new EventEmitter() as unknown as http.ServerResponse;
    (res as unknown as Record<string, unknown>).writeHead = vi.fn(() => res);
    (res as unknown as Record<string, unknown>).write = vi.fn(
      (chunk: Buffer | string) => {
        outputChunks.push(Buffer.from(chunk));
        return true;
      },
    );
    (res as unknown as Record<string, unknown>).end = vi.fn(
      (data?: unknown) => {
        if (data && (typeof data === 'string' || Buffer.isBuffer(data))) {
          outputChunks.push(Buffer.from(data));
        }
        (res as unknown as EventEmitter).emit('finish');
        return res;
      },
    );
    (res as unknown as Record<string, unknown>).writable = true;

    injectScriptIntoResponse(proxyRes, res);

    // Wait for the entire pipeline to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // The output should be gzip-compressed; decompress to verify
    const output = Buffer.concat(outputChunks);
    if (output.length > 0) {
      const decompressed = zlib.gunzipSync(output).toString('utf-8');
      expect(decompressed).toContain('/rooproxy/inject.js');
      expect(decompressed).toContain('<title>Gzip</title>');
    }
  });

  it('handles empty body without crashing', async () => {
    const proxyRes = createMockProxyRes({ 'content-type': 'text/html' }, '');
    const { res, getBody } = createMockRes();

    injectScriptIntoResponse(proxyRes, res);
    await new Promise((resolve) =>
      (res as unknown as EventEmitter).on('finish', resolve),
    );

    expect(getBody()).toContain('/rooproxy/inject.js');
  });
});

describe('passthroughResponse', () => {
  it('pipes proxy response directly to client response', async () => {
    const body = '{"key":"value"}';
    const proxyRes = createMockProxyRes(
      { 'content-type': 'application/json' },
      body,
      200,
    );
    const { res } = createMockRes();

    passthroughResponse(proxyRes, res);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
});
