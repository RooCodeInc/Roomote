// pnpm --filter @roomote/worker test src/services/__tests__/auth-proxy.test.ts

import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import {
  PROXY_ACCESS_LOG_PATH,
  extractPortNameFromHost,
  startAuthProxy,
  startMultiplexAuthProxy,
  testConnection,
  resolveLoopback,
  clearLoopbackCache,
  loopbackCache,
} from '../auth-proxy';

type AccessLogEntry = Record<string, unknown>;

async function canBindIpv6Loopback(): Promise<boolean> {
  const server = net.createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', () => resolve());
    });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      return false;
    }
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) =>
          closeError ? reject(closeError) : resolve(),
        );
      });
    }
  }
}

async function readProxyAccessLogEntries(): Promise<AccessLogEntry[]> {
  try {
    const content = await readFile(PROXY_ACCESS_LOG_PATH, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AccessLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function waitForProxyAccessLogEntry(
  predicate: (entry: AccessLogEntry) => boolean,
): Promise<AccessLogEntry> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const entries = await readProxyAccessLogEntries();
    const match = [...entries].reverse().find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for proxy access log entry');
}

describe('extractPortNameFromHost', () => {
  describe('taskId format (13-char base36)', () => {
    it('should extract port name from taskId-based host', () => {
      expect(
        extractPortNameFromHost('20imtw24sm6hv-web.preview.roomote.run'),
      ).toBe('WEB');
    });

    it('should extract port name with hyphen in port slug', () => {
      expect(
        extractPortNameFromHost('20imtw24sm6hv-my-app.preview.roomote.run'),
      ).toBe('MY_APP');
    });

    it('should convert lowercase to uppercase', () => {
      expect(
        extractPortNameFromHost('3579x1khed4zp-api.preview.roomote.run'),
      ).toBe('API');
    });

    it('should convert hyphens to underscores', () => {
      expect(
        extractPortNameFromHost('3579x1khed4zp-db-admin.preview.roomote.run'),
      ).toBe('DB_ADMIN');
    });
  });

  describe('edge cases', () => {
    it('should return null for host without domain suffix', () => {
      expect(extractPortNameFromHost('localhost')).toBeNull();
    });

    it('should return null for host without hyphen in subdomain', () => {
      expect(extractPortNameFromHost('nodash.preview.roomote.run')).toBeNull();
    });

    it('should return null for empty subdomain', () => {
      expect(extractPortNameFromHost('.preview.roomote.run')).toBeNull();
    });

    it('should return null for empty port name', () => {
      expect(
        extractPortNameFromHost('20imtw24sm6hv-.preview.roomote.run'),
      ).toBeNull();
    });

    it('should return null for short identifier', () => {
      expect(extractPortNameFromHost('abc123-web.localhost:3005')).toBeNull();
      expect(extractPortNameFromHost('short-api.example.com')).toBeNull();
    });

    it('should return null for non-taskId identifiers', () => {
      // 10-char identifiers that aren't 13-char taskIds should not match
      expect(
        extractPortNameFromHost('k5lx9czkmn-web.preview.roomote.run'),
      ).toBeNull();
      expect(
        extractPortNameFromHost('abcdefghij-web.preview.roomote.run'),
      ).toBeNull();
    });

    it('should return null for UUID format (no longer supported)', () => {
      expect(
        extractPortNameFromHost(
          '550e8400-e29b-41d4-a716-446655440000-web.preview.roomote.run',
        ),
      ).toBeNull();
    });

    it('should work with different domain suffixes', () => {
      expect(extractPortNameFromHost('20imtw24sm6hv-web.localhost:3005')).toBe(
        'WEB',
      );
      expect(extractPortNameFromHost('20imtw24sm6hv-api.example.com')).toBe(
        'API',
      );
    });
  });

  describe('port name conversion', () => {
    it('should convert single-word port names', () => {
      expect(extractPortNameFromHost('20imtw24sm6hv-web.domain.com')).toBe(
        'WEB',
      );
      expect(extractPortNameFromHost('20imtw24sm6hv-api.domain.com')).toBe(
        'API',
      );
      expect(extractPortNameFromHost('20imtw24sm6hv-docs.domain.com')).toBe(
        'DOCS',
      );
    });

    it('should convert multi-word port names with hyphens', () => {
      expect(extractPortNameFromHost('20imtw24sm6hv-my-app.domain.com')).toBe(
        'MY_APP',
      );
      expect(extractPortNameFromHost('20imtw24sm6hv-db-admin.domain.com')).toBe(
        'DB_ADMIN',
      );
      expect(
        extractPortNameFromHost('20imtw24sm6hv-api-gateway.domain.com'),
      ).toBe('API_GATEWAY');
    });

    it('should handle numeric suffixes', () => {
      expect(extractPortNameFromHost('20imtw24sm6hv-api-v2.domain.com')).toBe(
        'API_V2',
      );
      expect(extractPortNameFromHost('20imtw24sm6hv-worker-1.domain.com')).toBe(
        'WORKER_1',
      );
    });
  });
});

describe('startMultiplexAuthProxy subdomain rewriting', () => {
  let proxyServer: http.Server;
  let targetServer: http.Server;
  let targetPort: number;
  let proxyPort: number;
  let lastTargetRequest: {
    host: string | undefined;
    xForwardedHost: string | undefined;
    roomotePublicHost: string | undefined;
    origin: string | undefined;
  };

  beforeEach(async () => {
    lastTargetRequest = {
      host: undefined,
      xForwardedHost: undefined,
      roomotePublicHost: undefined,
      origin: undefined,
    };

    // Start a target HTTP server that records incoming headers
    targetServer = http.createServer((req, res) => {
      lastTargetRequest = {
        host: req.headers.host,
        xForwardedHost: req.headers['x-forwarded-host'] as string | undefined,
        roomotePublicHost: req.headers['x-roomote-public-host'] as
          | string
          | undefined,
        origin: req.headers.origin,
      };
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (proxyServer) {
        proxyServer.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('should rewrite Host header when subdomain is configured', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
      subdomains: { WEB: 'admin' },
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            'x-roomote-forwarded-proto': 'https',
            origin: 'https://20imtw24sm6hv-web.preview.roomote.run',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Status ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(lastTargetRequest.host).toBe(`admin.localhost:${targetPort}`);
    expect(lastTargetRequest.xForwardedHost).toBe(
      `admin.localhost:${targetPort}`,
    );
    expect(lastTargetRequest.origin).toBe(
      `https://admin.localhost:${targetPort}`,
    );
  });

  it('should not rewrite Host header when no subdomain is configured', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            'x-roomote-forwarded-proto': 'https',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Status ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

    // Host should NOT contain a subdomain rewrite
    expect(lastTargetRequest.host).not.toContain('admin.localhost');
  });

  it('should not rewrite Host for ports without a subdomain mapping', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
      subdomains: { API: 'api' }, // subdomain configured for API, not WEB
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            'x-roomote-forwarded-proto': 'https',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Status ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

    // Host should NOT contain a subdomain rewrite since WEB has no subdomain
    expect(lastTargetRequest.host).not.toContain('api.localhost');
  });

  it('should prefer x-roomote-public-host for x-forwarded-host and not forward Roomote headers', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/',
          headers: {
            'x-roomote-forwarded-host':
              '2ji2sj8jsddiv-web.preview-john.ngrok.app',
            'x-roomote-public-host':
              '2ji2sj8jsddiv-web-2b11ons4wqdmy-preview.preview-john.ngrok.app',
            'x-roomote-forwarded-proto': 'https',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Status ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(lastTargetRequest.xForwardedHost).toBe(
      '2ji2sj8jsddiv-web-2b11ons4wqdmy-preview.preview-john.ngrok.app',
    );
    expect(lastTargetRequest.roomotePublicHost).toBeUndefined();
  });

  it('should rewrite Host header for WebSocket upgrade', async () => {
    // Set up a target WebSocket server
    let wsHost: string | undefined;
    targetServer.on('upgrade', (req, socket) => {
      wsHost = req.headers.host;
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n\r\n');
      socket.end();
    });

    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
      subdomains: { WEB: 'admin' },
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/',
        headers: {
          'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
          'x-roomote-forwarded-proto': 'https',
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        resolve();
      });

      req.on('error', reject);
      req.end();
    });

    expect(wsHost).toBe(`admin.localhost:${targetPort}`);
  });

  it('should rewrite Location headers in redirect responses', async () => {
    // Replace target server with one that issues a redirect using the rewritten host
    targetServer.close();
    targetServer = http.createServer((req, res) => {
      const host = req.headers.host;
      res.writeHead(302, { Location: `http://${host}/dashboard` });
      res.end();
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(targetPort, '127.0.0.1', resolve);
    });

    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
      subdomains: { WEB: 'admin' },
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    const location = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            'x-roomote-forwarded-proto': 'https',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            resolve(res.headers.location || '');
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(location).toBe(
      'https://20imtw24sm6hv-web.preview.roomote.run/dashboard',
    );
  });
});

describe('auth bypass via cookie', () => {
  let proxyServer: http.Server;
  let targetServer: http.Server;
  let targetPort: number;
  let proxyPort: number;
  let lastTargetRequest: { url: string | undefined };
  const BYPASS_VALUE = 'test-bypass-secret';
  const BYPASS_HEADER_NAME = 'x-bypass-roomote-auth';

  beforeEach(async () => {
    lastTargetRequest = { url: undefined };

    targetServer = http.createServer((req, res) => {
      lastTargetRequest = { url: req.url };
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (proxyServer) {
        proxyServer.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('should bypass auth when bypass value is sent as a cookie', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/test-page',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            cookie: `${BYPASS_HEADER_NAME}=${BYPASS_VALUE}`,
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(200);
    expect(lastTargetRequest.url).toBe('/test-page');
  });

  it('should bypass auth when bypass value is sent as an HTTP header', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/test-page',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            [BYPASS_HEADER_NAME]: BYPASS_VALUE,
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(200);
    expect(lastTargetRequest.url).toBe('/test-page');
  });

  it('should return 401 when bypass cookie has wrong value', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/test-page',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
            cookie: `${BYPASS_HEADER_NAME}=wrong-value`,
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(401);
  });

  it('should return 401 when no bypass cookie or header is present', async () => {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/test-page',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(401);
  });

  it('should bypass auth for WebSocket upgrade with cookie', async () => {
    let wsUpgradeReceived = false;
    targetServer.on('upgrade', (req, socket) => {
      wsUpgradeReceived = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n\r\n');
      socket.end();
    });

    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });

    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/',
        headers: {
          'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
          cookie: `${BYPASS_HEADER_NAME}=${BYPASS_VALUE}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        resolve();
      });

      req.on('error', reject);
      req.end();
    });

    expect(wsUpgradeReceived).toBe(true);
  });
});

describe('multiplex auth cookie forwarding policy', () => {
  let proxyServer: http.Server;
  let targetServer: http.Server;
  let targetPort: number;
  let proxyPort: number;
  let lastHttpCookie: string | undefined;
  let lastWsCookie: string | undefined;
  const AUTH_COOKIE_NAME = 'preview_auth_nested';
  const BYPASS_COOKIE_NAME = 'x-bypass-roomote-auth';

  function parseCookieHeader(
    cookieHeader: string | undefined,
  ): Record<string, string> {
    if (!cookieHeader) {
      return {};
    }

    return cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .reduce(
        (acc, cookie) => {
          const [name, ...valueParts] = cookie.split('=');
          if (!name) {
            return acc;
          }
          acc[name] = valueParts.join('=');
          return acc;
        },
        {} as Record<string, string>,
      );
  }

  async function startProxy(): Promise<void> {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort, PREVIEW: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB', 'PREVIEW']),
      wildcardPrefixPorts: new Set(['PREVIEW']),
      authCookieName: AUTH_COOKIE_NAME,
      authBypassHeaderName: BYPASS_COOKIE_NAME,
    });
    proxyPort = (proxyServer.address() as { port: number }).port;
  }

  async function sendHttp(forwardedHost: string): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/cookie-policy',
          headers: {
            'x-roomote-forwarded-host': forwardedHost,
            cookie: `${AUTH_COOKIE_NAME}=token123; foo=bar; ${BYPASS_COOKIE_NAME}=bypass123`,
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  async function sendWs(forwardedHost: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/cookie-policy-ws',
        headers: {
          'x-roomote-forwarded-host': forwardedHost,
          cookie: `${AUTH_COOKIE_NAME}=token123; foo=bar; ${BYPASS_COOKIE_NAME}=bypass123`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        resolve();
      });
      req.on('response', (res) => {
        reject(new Error(`Unexpected response status: ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  beforeEach(async () => {
    lastHttpCookie = undefined;
    lastWsCookie = undefined;

    targetServer = http.createServer((req, res) => {
      lastHttpCookie = req.headers.cookie;
      res.writeHead(200);
      res.end('ok');
    });

    targetServer.on('upgrade', (req, socket) => {
      lastWsCookie = req.headers.cookie;
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n\r\n');
      socket.end();
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (proxyServer) {
        proxyServer.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('preserves auth cookie for wildcard HTTP routes', async () => {
    await startProxy();

    const statusCode = await sendHttp(
      '20imtw24sm6hv-web-outertask-preview.preview.roomote.run',
    );

    expect(statusCode).toBe(200);
    expect(parseCookieHeader(lastHttpCookie)).toEqual({
      [AUTH_COOKIE_NAME]: 'token123',
      foo: 'bar',
    });
  });

  it('strips auth cookie for non-wildcard HTTP routes', async () => {
    await startProxy();

    const statusCode = await sendHttp('20imtw24sm6hv-web.preview.roomote.run');

    expect(statusCode).toBe(200);
    expect(parseCookieHeader(lastHttpCookie)).toEqual({ foo: 'bar' });
  });

  it('preserves auth cookie for wildcard WebSocket routes', async () => {
    await startProxy();

    await sendWs('20imtw24sm6hv-web-outertask-preview.preview.roomote.run');

    expect(parseCookieHeader(lastWsCookie)).toEqual({
      [AUTH_COOKIE_NAME]: 'token123',
      foo: 'bar',
    });
  });

  it('strips auth cookie for non-wildcard WebSocket routes', async () => {
    await startProxy();

    await sendWs('20imtw24sm6hv-web.preview.roomote.run');

    expect(parseCookieHeader(lastWsCookie)).toEqual({ foo: 'bar' });
  });
});

describe('multiplex websocket origin and host policies', () => {
  let proxyServer: http.Server | undefined;
  let targetServer: http.Server | undefined;
  let targetPort = 0;
  let proxyPort = 0;
  let lastWsHeaders: {
    host: string | undefined;
    xForwardedHost: string | undefined;
    roomoteForwardedHost: string | undefined;
    origin: string | undefined;
  };

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

  function writeWsResponse(
    socket: NodeJS.ReadWriteStream,
    statusCode: 101 | 403,
  ): void {
    if (statusCode === 101) {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n\r\n');
      socket.end();
      return;
    }

    socket.write('HTTP/1.1 403 Forbidden\r\n');
    socket.write('Content-Type: text/plain\r\n');
    socket.write('Content-Length: 9\r\n');
    socket.write('Connection: close\r\n\r\n');
    socket.write('Forbidden');
    socket.end();
  }

  async function closeServer(server?: http.Server): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (
          err &&
          !(
            (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' ||
            err.message === 'Server is not running.'
          )
        ) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async function startTarget(
    policy: (headers: http.IncomingHttpHeaders) => boolean,
  ): Promise<void> {
    targetServer = http.createServer();
    targetServer.on('upgrade', (req, socket) => {
      lastWsHeaders = {
        host: req.headers.host,
        xForwardedHost: req.headers['x-forwarded-host'] as string | undefined,
        roomoteForwardedHost: req.headers['x-roomote-forwarded-host'] as
          | string
          | undefined,
        origin: req.headers.origin as string | undefined,
      };

      writeWsResponse(socket, policy(req.headers) ? 101 : 403);
    });

    await new Promise<void>((resolve) => {
      targetServer!.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer!.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async function startProxy(
    options: { subdomains?: Record<string, string> } = {},
  ): Promise<void> {
    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort, PREVIEW: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB', 'PREVIEW']),
      wildcardPrefixPorts: new Set(['PREVIEW']),
      subdomains: options.subdomains,
    });
    proxyPort = (proxyServer.address() as { port: number }).port;
  }

  async function sendWs({
    forwardedHost,
    origin,
  }: {
    forwardedHost: string;
    origin: string;
  }): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/ws-policy',
        headers: {
          'x-roomote-forwarded-host': forwardedHost,
          'x-roomote-forwarded-proto': 'https',
          origin,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        resolve(101);
      });
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on('end', () => resolve(status));
      });
      req.on('error', reject);
      req.end();
    });
  }

  beforeEach(() => {
    lastWsHeaders = {
      host: undefined,
      xForwardedHost: undefined,
      roomoteForwardedHost: undefined,
      origin: undefined,
    };
  });

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(targetServer);
    proxyServer = undefined;
    targetServer = undefined;
  });

  it('supports strict Origin.host == X-Forwarded-Host policy on non-subdomain routes', async () => {
    await startTarget((headers) => {
      const originHost = getOriginHost(headers.origin);
      const forwardedHost = headers['x-forwarded-host'];
      return typeof forwardedHost === 'string' && originHost === forwardedHost;
    });
    await startProxy();

    const publicHost = '20imtw24sm6hv-web.preview.roomote.run';

    const sandboxStatus = await sendWs({
      forwardedHost: publicHost,
      origin: 'https://sb-7od07onq1vfi.vercel.run',
    });
    const publicStatus = await sendWs({
      forwardedHost: publicHost,
      origin: `https://${publicHost}`,
    });

    expect(sandboxStatus).toBe(403);
    expect(publicStatus).toBe(101);
    expect(lastWsHeaders.host).toBe(publicHost);
    expect(lastWsHeaders.xForwardedHost).toBe(publicHost);
    expect(lastWsHeaders.origin).toBe(`https://${publicHost}`);
  });

  it('supports allowlisted public preview origin policies', async () => {
    const publicHost = '20imtw24sm6hv-web.preview.roomote.run';
    const allowlistedOrigin = `https://${publicHost}`;

    await startTarget((headers) => headers.origin === allowlistedOrigin);
    await startProxy();

    const publicStatus = await sendWs({
      forwardedHost: publicHost,
      origin: allowlistedOrigin,
    });
    const sandboxStatus = await sendWs({
      forwardedHost: publicHost,
      origin: 'https://sb-7od07onq1vfi.vercel.run',
    });

    expect(publicStatus).toBe(101);
    expect(sandboxStatus).toBe(403);
  });

  it('keeps subdomain rewrite semantics for strict Origin.host == Host policies', async () => {
    await startTarget((headers) => {
      const originHost = getOriginHost(headers.origin);
      return originHost != null && originHost === headers.host;
    });
    await startProxy({ subdomains: { WEB: 'admin' } });

    const publicHost = '20imtw24sm6hv-web.preview.roomote.run';
    const status = await sendWs({
      forwardedHost: publicHost,
      origin: `https://${publicHost}`,
    });

    expect(status).toBe(101);
    expect(lastWsHeaders.host).toBe(`admin.localhost:${targetPort}`);
    expect(lastWsHeaders.xForwardedHost).toBe(`admin.localhost:${targetPort}`);
    expect(lastWsHeaders.origin).toBe(`https://admin.localhost:${targetPort}`);
  });

  it('supports strict Origin.host == Host policy on non-subdomain routes', async () => {
    await startTarget((headers) => {
      const originHost = getOriginHost(headers.origin);
      return originHost != null && originHost === headers.host;
    });
    await startProxy();

    const publicHost = '20imtw24sm6hv-web.preview.roomote.run';
    const status = await sendWs({
      forwardedHost: publicHost,
      origin: `https://${publicHost}`,
    });

    expect(status).toBe(101);
    expect(lastWsHeaders.host).toBe(publicHost);
    expect(lastWsHeaders.xForwardedHost).toBe(publicHost);
    expect(lastWsHeaders.origin).toBe(`https://${publicHost}`);
  });

  it('preserves wildcard nested routing headers for strict WS upstream checks', async () => {
    await startTarget((headers) => {
      const originHost = getOriginHost(headers.origin);
      const forwardedHost = headers['x-forwarded-host'];
      return typeof forwardedHost === 'string' && originHost === forwardedHost;
    });
    await startProxy();

    const nestedHost =
      '20imtw24sm6hv-web-outertask-preview.preview.roomote.run';
    const status = await sendWs({
      forwardedHost: nestedHost,
      origin: `https://${nestedHost}`,
    });

    expect(status).toBe(101);
    expect(lastWsHeaders.xForwardedHost).toBe(nestedHost);
    expect(lastWsHeaders.roomoteForwardedHost).toBe(nestedHost);
    expect(lastWsHeaders.origin).toBe(`https://${nestedHost}`);
  });
});

describe('proxy access logging', () => {
  let proxyServer: http.Server | undefined;
  let targetServer: http.Server | undefined;
  let targetPort = 0;
  let proxyPort = 0;

  async function closeServer(server?: http.Server): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (
          err &&
          !(
            (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' ||
            err.message === 'Server is not running.'
          )
        ) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async function reserveUnusedPort(): Promise<number> {
    const server = http.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const port = (server.address() as { port: number }).port;
    await closeServer(server);
    return port;
  }

  beforeEach(async () => {
    await rm(PROXY_ACCESS_LOG_PATH, { force: true });
  });

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(targetServer);
    await rm(PROXY_ACCESS_LOG_PATH, { force: true });
  });

  it('writes access entries for HTTP proxy requests', async () => {
    targetServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      targetServer!.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer!.address() as { port: number }).port;
        resolve();
      });
    });

    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
    });
    proxyPort = (proxyServer.address() as { port: number }).port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/access-http',
          headers: {
            'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(200);

    const entry = await waitForProxyAccessLogEntry(
      (candidate) =>
        candidate.type === 'access' && candidate.path === '/access-http',
    );

    expect(entry.proxy).toBe('multiplex-auth-proxy');
    expect(entry.statusCode).toBe(200);
    expect(entry.outcome).toBe('proxied');
    expect(entry.portName).toBe('WEB');
    expect(entry.targetPort).toBe(targetPort);
  });

  it('writes ws_access entries for upgraded websocket requests', async () => {
    targetServer = http.createServer();
    targetServer.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n\r\n');
      socket.end();
    });

    await new Promise<void>((resolve) => {
      targetServer!.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer!.address() as { port: number }).port;
        resolve();
      });
    });

    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
    });
    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/access-ws',
        headers: {
          'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        resolve();
      });
      req.on('response', (res) => {
        reject(new Error(`Unexpected response status: ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });

    const entry = await waitForProxyAccessLogEntry(
      (candidate) =>
        candidate.type === 'ws_access' && candidate.path === '/access-ws',
    );

    expect(entry.proxy).toBe('multiplex-auth-proxy');
    expect(entry.statusCode).toBe(101);
    expect(entry.outcome).toBe('proxied');
    expect(entry.portName).toBe('WEB');
    expect(entry.targetPort).toBe(targetPort);
  });

  it('logs failed multiplex websocket upgrades as upstream_error, not proxied', async () => {
    targetPort = await reserveUnusedPort();

    proxyServer = await startMultiplexAuthProxy({
      listenPort: 0,
      portMapping: { WEB: targetPort },
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      unauthenticatedPorts: new Set(['WEB']),
    });
    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/access-ws-fail',
        headers: {
          'x-roomote-forwarded-host': '20imtw24sm6hv-web.preview.roomote.run',
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        reject(new Error('Unexpected successful websocket upgrade'));
      });
      req.on('response', (res) => {
        res.resume();
        res.on('end', complete);
      });
      req.on('error', () => {
        complete();
      });
      req.end();

      setTimeout(complete, 250);
    });

    const entry = await waitForProxyAccessLogEntry(
      (candidate) =>
        candidate.type === 'ws_access' && candidate.path === '/access-ws-fail',
    );

    expect(entry.proxy).toBe('multiplex-auth-proxy');
    expect(entry.outcome).toBe('upstream_error');
    expect(entry.statusCode).toBeUndefined();

    const entries = await readProxyAccessLogEntries();
    const proxied = entries.find(
      (candidate) =>
        candidate.type === 'ws_access' &&
        candidate.path === '/access-ws-fail' &&
        candidate.outcome === 'proxied',
    );
    expect(proxied).toBeUndefined();
  });

  it('logs failed auth-proxy websocket upgrades as upstream_error, not proxied', async () => {
    targetPort = await reserveUnusedPort();

    proxyServer = await startAuthProxy({
      listenPort: 0,
      targetPort,
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      skipAuth: true,
    });
    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/auth-ws-fail',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        reject(new Error('Unexpected successful websocket upgrade'));
      });
      req.on('response', (res) => {
        res.resume();
        res.on('end', complete);
      });
      req.on('error', () => {
        complete();
      });
      req.end();

      setTimeout(complete, 250);
    });

    const entry = await waitForProxyAccessLogEntry(
      (candidate) =>
        candidate.type === 'ws_access' && candidate.path === '/auth-ws-fail',
    );

    expect(entry.proxy).toBe('auth-proxy');
    expect(entry.outcome).toBe('upstream_error');
    expect(entry.statusCode).toBeUndefined();

    const entries = await readProxyAccessLogEntries();
    const proxied = entries.find(
      (candidate) =>
        candidate.type === 'ws_access' &&
        candidate.path === '/auth-ws-fail' &&
        candidate.outcome === 'proxied',
    );
    expect(proxied).toBeUndefined();
  });
});

describe('standalone auth-proxy bypass', () => {
  let proxyServer: http.Server | undefined;
  let targetServer: http.Server | undefined;
  let targetPort = 0;
  let proxyPort = 0;
  let lastTargetRequest: {
    bypassHeader?: string | string[];
    cookie?: string;
    url?: string;
  };
  const BYPASS_VALUE = 'legacy-editor-bypass-secret';
  const BYPASS_HEADER_NAME = 'x-bypass-roomote-auth';

  beforeEach(async () => {
    lastTargetRequest = {};

    targetServer = http.createServer((req, res) => {
      lastTargetRequest = {
        url: req.url,
        cookie: req.headers.cookie,
        bypassHeader: req.headers[BYPASS_HEADER_NAME],
      };
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    targetServer.on('upgrade', (req, socket) => {
      lastTargetRequest = {
        url: req.url,
        cookie: req.headers.cookie,
        bypassHeader: req.headers[BYPASS_HEADER_NAME],
      };
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n\r\n');
      socket.end();
    });

    await new Promise<void>((resolve) => {
      targetServer!.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer!.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (proxyServer) {
        proxyServer.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });

    await new Promise<void>((resolve, reject) => {
      if (targetServer) {
        targetServer.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
  });

  it('accepts the trusted bypass header for standalone HTTP auth-proxy requests', async () => {
    proxyServer = await startAuthProxy({
      listenPort: 0,
      targetPort,
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });
    proxyPort = (proxyServer.address() as { port: number }).port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/editor',
          headers: {
            [BYPASS_HEADER_NAME]: BYPASS_VALUE,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(200);
    expect(lastTargetRequest.url).toBe('/editor');
    expect(lastTargetRequest.bypassHeader).toBeUndefined();
  });

  it('accepts the trusted bypass header for standalone WebSocket auth-proxy requests', async () => {
    proxyServer = await startAuthProxy({
      listenPort: 0,
      targetPort,
      publicKey: Buffer.from('unused').toString('base64'),
      taskId: 'test-task',
      authBypassHeaderValue: BYPASS_VALUE,
      authBypassHeaderName: BYPASS_HEADER_NAME,
    });
    proxyPort = (proxyServer.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/editor-ws',
        headers: {
          [BYPASS_HEADER_NAME]: BYPASS_VALUE,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('test-key').toString('base64'),
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.end();
        resolve();
      });
      req.on('error', reject);
      req.end();
    });

    expect(lastTargetRequest.url).toBe('/editor-ws');
    expect(lastTargetRequest.bypassHeader).toBeUndefined();
  });
});

describe('loopback address probing', () => {
  afterEach(() => {
    loopbackCache.clear();
  });

  describe('testConnection', () => {
    it('should return true for a listening IPv4 port', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const port = (server.address() as net.AddressInfo).port;

      try {
        expect(await testConnection('127.0.0.1', port)).toBe(true);
      } finally {
        server.close();
      }
    });

    it('should return true for a listening IPv6 port', async () => {
      if (!(await canBindIpv6Loopback())) {
        return;
      }

      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
      const port = (server.address() as net.AddressInfo).port;

      try {
        expect(await testConnection('::1', port)).toBe(true);
      } finally {
        server.close();
      }
    });

    it('should return false for a non-listening port', async () => {
      // Use an ephemeral port that's very unlikely to be in use
      expect(await testConnection('127.0.0.1', 19999)).toBe(false);
    });

    it('should handle bracketed IPv6 addresses', async () => {
      if (!(await canBindIpv6Loopback())) {
        return;
      }

      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
      const port = (server.address() as net.AddressInfo).port;

      try {
        // testConnection strips brackets for net.connect
        expect(await testConnection('[::1]', port)).toBe(true);
      } finally {
        server.close();
      }
    });
  });

  describe('resolveLoopback', () => {
    it('should resolve to 127.0.0.1 for IPv4-only server', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const port = (server.address() as net.AddressInfo).port;

      try {
        const addr = await resolveLoopback(port);
        expect(addr).toBe('127.0.0.1');
      } finally {
        server.close();
      }
    });

    it('should resolve to [::1] for IPv6-only server', async () => {
      if (!(await canBindIpv6Loopback())) {
        return;
      }

      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
      const port = (server.address() as net.AddressInfo).port;

      try {
        const addr = await resolveLoopback(port);
        expect(addr).toBe('[::1]');
      } finally {
        server.close();
      }
    });

    it('should cache the result', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const port = (server.address() as net.AddressInfo).port;

      try {
        await resolveLoopback(port);
        expect(loopbackCache.has(port)).toBe(true);
        expect(loopbackCache.get(port)).toBe('127.0.0.1');

        // Second call should use cache (even if server stops)
        server.close();
        const addr = await resolveLoopback(port);
        expect(addr).toBe('127.0.0.1');
      } finally {
        // server already closed
      }
    });

    it('should default to 127.0.0.1 when nothing responds', async () => {
      const addr = await resolveLoopback(19998);
      expect(addr).toBe('127.0.0.1');
      // Should NOT cache the default
      expect(loopbackCache.has(19998)).toBe(false);
    });
  });

  describe('clearLoopbackCache', () => {
    it('should clear cached address for a port', async () => {
      loopbackCache.set(12345, '127.0.0.1');
      expect(loopbackCache.has(12345)).toBe(true);

      clearLoopbackCache(12345);
      expect(loopbackCache.has(12345)).toBe(false);
    });
  });

  describe('multiplex proxy IPv6 integration', () => {
    let proxyServer: http.Server;
    let targetServer: http.Server;
    let targetPort: number;
    let proxyPort: number;

    afterEach(async () => {
      loopbackCache.clear();
      await new Promise<void>((resolve, reject) => {
        if (proxyServer) {
          proxyServer.close((err) => (err ? reject(err) : resolve()));
        } else {
          resolve();
        }
      });
      await new Promise<void>((resolve, reject) => {
        if (targetServer) {
          targetServer.close((err) => (err ? reject(err) : resolve()));
        } else {
          resolve();
        }
      });
    });

    it('should proxy to an IPv6-only target server', async () => {
      if (!(await canBindIpv6Loopback())) {
        return;
      }

      // Start target on IPv6 only (simulating storybook --host localhost on Linux)
      targetServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello from ipv6');
      });

      await new Promise<void>((resolve) => {
        targetServer.listen(0, '::1', () => {
          targetPort = (targetServer.address() as net.AddressInfo).port;
          resolve();
        });
      });

      proxyServer = await startMultiplexAuthProxy({
        listenPort: 0,
        portMapping: { WEB: targetPort },
        publicKey: Buffer.from('unused').toString('base64'),
        taskId: 'test-task',
        unauthenticatedPorts: new Set(['WEB']),
      });

      proxyPort = (proxyServer.address() as net.AddressInfo).port;

      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/',
            headers: {
              'x-roomote-forwarded-host':
                '20imtw24sm6hv-web.preview.roomote.run',
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              if (res.statusCode === 200) resolve(data);
              else reject(new Error(`Status ${res.statusCode}: ${data}`));
            });
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(body).toBe('hello from ipv6');
      expect(loopbackCache.get(targetPort)).toBe('[::1]');
    });
  });
});
