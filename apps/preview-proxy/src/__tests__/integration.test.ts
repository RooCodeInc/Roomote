import request from 'supertest';
import { PassThrough } from 'node:stream';
import {
  TEST_HOST,
  TEST_TASK_ID,
  mockConfig,
  createMockAuthResult,
  createMockCloudJob,
  createMockParseHostResult,
  createMockResolvedRequest,
} from './fixtures';

vi.mock('../config', () => ({
  config: mockConfig,
}));

vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  escapeForLog: (s: string) => s,
}));

vi.mock('../lib/redis', () => {
  const store = new Map<string, { value: string; expiresAt: number }>();

  return {
    setWithExpiry: vi.fn(
      async (key: string, value: string, ttlSeconds: number) => {
        store.set(key, {
          value,
          expiresAt: Date.now() + ttlSeconds * 1000,
        });
      },
    ),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock('../services/auth', () => ({
  resolveRequestContext: vi.fn(),
  validateAuthCookieForCloudJob: vi.fn(),
  storeState: vi.fn().mockResolvedValue(undefined),
  validateState: vi.fn(),
  validateToken: vi.fn(),
}));

vi.mock('../services/resolver', () => ({
  resolveRequest: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  validatePreviewToken: vi.fn(),
}));

vi.mock('../lib/url-parser', () => ({
  parseHost: (_host: string) => createMockParseHostResult(),
  parseHostWithSuffix: (_host: string, _suffix: string) =>
    createMockParseHostResult({ isValid: false }),
  parseHostNested: (_host: string) => ({
    outerTaskId: null,
    outerPortName: '',
    innerPrefix: '',
    isValid: false,
  }),
  parseHostForConfig: (_host: string, _suffix?: string) =>
    createMockParseHostResult(),
  stripSuffixFromHost: (host: string, _suffix: string) => host,
}));

vi.mock('../lib/nested-routing', () => ({
  tryNestedFallback: vi.fn().mockResolvedValue(null),
}));

vi.mock('../handlers/auto-resume', () => ({
  triggerAutoResume: vi.fn(),
}));

let server: import('http').Server;
let proxy: typeof import('../index').proxy;

beforeAll(async () => {
  const mod = await import('../index');
  server = mod.server;
  proxy = mod.proxy;
});

afterAll(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('preview-proxy integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes x-roomote-request-id on health responses', async () => {
    const res = await request(server).get('/health').set('Host', TEST_HOST);

    expect(res.status).toBe(200);
    expect(res.headers['x-roomote-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('forwards normalized correlation headers to upstream requests', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        requiresAuth: false,
      }),
    );

    const proxyWebSpy = vi
      .spyOn(proxy, 'web')
      .mockImplementation((req, res, _options, _callback) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('proxied');
      });

    const validTraceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const res = await request(server)
      .get('/some/path')
      .set('Host', TEST_HOST)
      .set('x-request-id', 'req-123')
      .set('traceparent', validTraceparent);

    expect(res.status).toBe(200);
    expect(proxyWebSpy).toHaveBeenCalledTimes(1);

    const [upstreamReq] = proxyWebSpy.mock.calls[0]!;
    expect(upstreamReq.headers['x-request-id']).toBe('req-123');
    expect(upstreamReq.headers.traceparent).toBe(validTraceparent);
  });

  it('drops tracestate when restarting an invalid trace', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        requiresAuth: false,
      }),
    );

    const proxyWebSpy = vi
      .spyOn(proxy, 'web')
      .mockImplementation((req, res, _options, _callback) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('proxied');
      });

    const res = await request(server)
      .get('/some/path')
      .set('Host', TEST_HOST)
      .set('traceparent', '00-not-valid-parent')
      .set('tracestate', 'vendor=value');

    expect(res.status).toBe(200);

    const [upstreamReq] = proxyWebSpy.mock.calls[0]!;
    expect(upstreamReq.headers.tracestate).toBeUndefined();
    expect(String(upstreamReq.headers.traceparent)).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  it('sets x-roomote-public-host in inner mode so downstream canonical redirects use nested host', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        requiresAuth: false,
      }),
    );

    const proxyWebSpy = vi
      .spyOn(proxy, 'web')
      .mockImplementation((req, res, _options, _callback) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('proxied');
      });

    const originalSuffix = mockConfig.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
    mockConfig.PREVIEW_PROXY_SUBDOMAIN_SUFFIX = '2b11ons4wqdmy-preview';

    try {
      const nestedHost =
        '2ji2sj8jsddiv-web-2b11ons4wqdmy-preview.preview-john.ngrok.app';

      const res = await request(server)
        .get('/some/path')
        .set('Host', 'sandbox-internal-host')
        .set('x-roomote-forwarded-host', nestedHost);

      expect(res.status).toBe(200);
      expect(proxyWebSpy).toHaveBeenCalledTimes(1);

      const [upstreamReq] = proxyWebSpy.mock.calls[0]!;
      expect(upstreamReq.headers['x-roomote-public-host']).toBe(nestedHost);
    } finally {
      mockConfig.PREVIEW_PROXY_SUBDOMAIN_SUFFIX = originalSuffix;
    }
  });

  it('preserves upstream x-request-id and adds x-roomote-request-id', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        requiresAuth: false,
      }),
    );

    vi.spyOn(proxy, 'web').mockImplementation((req, res) => {
      const proxyRes = new PassThrough() as PassThrough & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      proxyRes.statusCode = 200;
      proxyRes.headers = {
        'content-type': 'text/plain',
        'x-request-id': 'upstream-req-999',
      };

      proxy.emit(
        'proxyRes',
        proxyRes as unknown as import('http').IncomingMessage,
        req,
        res,
      );
      proxyRes.end('proxied');
    });

    const res = await request(server)
      .get('/some/path')
      .set('Host', TEST_HOST)
      .set('x-request-id', 'req-123');

    expect(res.status).toBe(200);
    expect(res.text).toBe('proxied');
    expect(res.headers['x-request-id']).toBe('upstream-req-999');
    expect(res.headers['x-roomote-request-id']).toBe('req-123');
  });

  it('returns 401 JSON + CORS headers for unauthenticated non-navigation requests', async () => {
    const { resolveRequest } = await import('../services/resolver');
    const { validateAuthCookieForCloudJob } = await import('../services/auth');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        requiresAuth: true,
      }),
    );
    vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
      createMockAuthResult(),
    );

    const res = await request(server)
      .get('/api/data')
      .set('Host', TEST_HOST)
      .set('Origin', 'https://other.example.com')
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://other.example.com',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers.vary).toContain('Origin');
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('redirect uses x-forwarded-proto when navigating', async () => {
    const { resolveRequest } = await import('../services/resolver');
    const { validateAuthCookieForCloudJob } = await import('../services/auth');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        requiresAuth: true,
      }),
    );
    vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
      createMockAuthResult(),
    );

    const res = await request(server)
      .get('/some/path?x=1')
      .set('Host', TEST_HOST)
      .set('sec-fetch-mode', 'navigate')
      .set('x-forwarded-proto', 'http');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('redirect_uri=http%3A%2F%2F');
  });

  it('returns health check response', async () => {
    const res = await request(server).get('/health').set('Host', TEST_HOST);

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });

  describe('auth callback state handling', () => {
    it('forwards nested callback when state is missing locally', async () => {
      const { validateState } = await import('../services/auth');
      const { tryNestedFallback } = await import('../lib/nested-routing');

      vi.mocked(validateState).mockResolvedValue(null);
      vi.mocked(tryNestedFallback).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          sandboxUrl: 'http://127.0.0.1:65534',
          requiresAuth: false,
        }),
      );

      const res = await request(server)
        .get('/auth/callback?token=test-token&state=test-state')
        .set(
          'Host',
          '1gu10jmcguotx-editor-3skyktz75398v-preview.preview-john.ngrok.app',
        );

      // Forwarding attempts to proxy to nested sandbox; unreachable target yields 502.
      expect(res.status).toBe(502);
    });

    it('returns 400 for non-nested callback when state is missing', async () => {
      const { validateState } = await import('../services/auth');
      const { tryNestedFallback } = await import('../lib/nested-routing');

      vi.mocked(validateState).mockResolvedValue(null);
      vi.mocked(tryNestedFallback).mockResolvedValue(null);

      const res = await request(server)
        .get('/auth/callback?token=test-token&state=test-state')
        .set('Host', TEST_HOST);

      expect(res.status).toBe(400);
      expect(res.text).toContain('Invalid or expired state');
    });
  });

  it('returns 404 for not found status', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'not_found',
      }),
    );

    const res = await request(server)
      .get('/some/path')
      .set('Host', TEST_HOST)
      .set('Accept', 'text/html');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 503 for sandbox_unavailable status', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'sandbox_unavailable',
      }),
    );

    const res = await request(server)
      .get('/some/path')
      .set('Host', TEST_HOST)
      .set('Accept', 'text/html');

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 410 for gone status', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'gone',
      }),
    );

    const res = await request(server)
      .get('/some/path')
      .set('Host', TEST_HOST)
      .set('Accept', 'text/html');

    expect(res.status).toBe(410);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('redirects for redirect status', async () => {
    const { resolveRequest } = await import('../services/resolver');

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'redirect',
        redirectUrl: 'https://example.com/new-url',
      }),
    );

    const res = await request(server).get('/some/path').set('Host', TEST_HOST);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/new-url');
  });

  describe('redirect_to_direct (unproxied ports)', () => {
    it('redirects to auth for unauthenticated navigation requests', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'redirect_to_direct',
          directUrl: 'https://direct-sandbox.example.com:3000',
          requiresAuth: true,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate');

      expect(res.status).toBe(302);
      // Should redirect to auth endpoint, not the direct URL
      expect(res.headers.location).toContain('/api/auth/preview');
      expect(res.headers.location).not.toContain('direct-sandbox');
    });

    it('redirects to direct URL after auth validation', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'redirect_to_direct',
          directUrl: 'https://direct-sandbox.example.com:3000',
          requiresAuth: true,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: true }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('Cookie', 'preview_auth=valid-token');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        'https://direct-sandbox.example.com:3000',
      );
    });

    it('returns 401 JSON for unauthenticated non-navigation requests', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'redirect_to_direct',
          directUrl: 'https://direct-sandbox.example.com:3000',
          requiresAuth: true,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/api/data')
        .set('Host', TEST_HOST)
        .set('Origin', 'https://other.example.com')
        .set('Accept', 'application/json');

      expect(res.status).toBe(401);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://other.example.com',
      );
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('redirects to direct URL when auth not required', async () => {
      const { resolveRequest } = await import('../services/resolver');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'redirect_to_direct',
          directUrl: 'https://direct-sandbox.example.com:3000',
          requiresAuth: false,
        }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        'https://direct-sandbox.example.com:3000',
      );
    });
  });

  describe('resumable status (auto-resume)', () => {
    it('redirects to auth for unauthenticated navigation requests', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'resumable',
          snapshotId: 'snap_test123',
          snapshotCreatedAt: new Date(),
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate');

      expect(res.status).toBe(302);
      // Should redirect to auth endpoint
      expect(res.headers.location).toContain('/api/auth/preview');
    });

    it('returns 401 JSON for unauthenticated non-navigation requests', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'resumable',
          snapshotId: 'snap_test123',
          snapshotCreatedAt: new Date(),
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/api/data')
        .set('Host', TEST_HOST)
        .set('Origin', 'https://other.example.com')
        .set('Accept', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('auth redirect without taskId (blank sessions)', () => {
    it('returns 500 for active jobs without taskId', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      const cloudJobWithoutTask = createMockCloudJob({
        id: 42,
        taskId: null,
      });

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          requiresAuth: true,
          cloudJob: cloudJobWithoutTask,
          taskId: undefined,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate');

      // Without taskId, the server returns 500 (cloud_job_id fallback removed)
      expect(res.status).toBe(500);
    });

    it('uses task_id when taskId is available', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          requiresAuth: true,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/api/auth/preview');
      expect(res.headers.location).toContain('task_id=' + TEST_TASK_ID);
      expect(res.headers.location).not.toContain('cloud_job_id');
    });

    it('returns 500 for redirect_to_direct without taskId', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      const cloudJobWithoutTask = createMockCloudJob({
        id: 99,
        taskId: null,
      });

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'redirect_to_direct',
          directUrl: 'https://direct-sandbox.example.com:3000',
          requiresAuth: true,
          cloudJob: cloudJobWithoutTask,
          taskId: undefined,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate');

      // Without taskId, the server returns 500 (cloud_job_id fallback removed)
      expect(res.status).toBe(500);
    });

    it('returns 500 for resumable without taskId', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      const cloudJobWithoutTask = createMockCloudJob({
        id: 77,
        taskId: null,
      });

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'resumable',
          snapshotId: 'snap_test123',
          snapshotCreatedAt: new Date(),
          cloudJob: cloudJobWithoutTask,
          taskId: undefined,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'missing' }),
      );

      const res = await request(server)
        .get('/some/path')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate');

      // Without taskId, the server returns 500 (cloud_job_id fallback removed)
      expect(res.status).toBe(500);
    });
  });

  describe('resume-status endpoint', () => {
    it('returns 401 without auth cookie', async () => {
      const res = await request(server)
        .get('/rooproxy/resume-status/123')
        .set('Host', TEST_HOST);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
    });

    it('uses configured preview auth cookie name', async () => {
      const { validatePreviewToken } = await import('@roomote/auth');
      vi.mocked(validatePreviewToken).mockRejectedValue(
        new Error('invalid token'),
      );

      const originalCookieName = mockConfig.PREVIEW_AUTH_COOKIE_NAME;
      mockConfig.PREVIEW_AUTH_COOKIE_NAME = 'preview_auth_nested';

      try {
        const wrongCookieRes = await request(server)
          .get('/rooproxy/resume-status/123')
          .set('Host', TEST_HOST)
          .set('Cookie', 'preview_auth=token-from-default-name');

        expect(wrongCookieRes.status).toBe(401);
        expect(wrongCookieRes.body.error).toBe('Authentication required');
        expect(validatePreviewToken).not.toHaveBeenCalled();

        const configuredCookieRes = await request(server)
          .get('/rooproxy/resume-status/123')
          .set('Host', TEST_HOST)
          .set('Cookie', 'preview_auth_nested=token-from-configured-name');

        expect(configuredCookieRes.status).toBe(401);
        expect(configuredCookieRes.body.error).toBe('Authentication failed');
        expect(validatePreviewToken).toHaveBeenCalledWith(
          'token-from-configured-name',
        );
      } finally {
        mockConfig.PREVIEW_AUTH_COOKIE_NAME = originalCookieName;
      }
    });
  });

  describe('inline __preview_token (iframe trampoline)', () => {
    it('redirects with preview_auth Set-Cookie when token is valid', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          requiresAuth: true,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({
          valid: true,
          token: {
            userId: 'user-1',
            tokenType: 'pt',
            version: 1,
          },
        }),
      );

      const res = await request(server)
        .get('/?__preview_token=valid-token')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate')
        .redirects(0);

      expect(res.status).toBe(302);

      // Token should be stripped from the redirect Location
      expect(res.headers.location).not.toContain('__preview_token=');

      // Should include a redirect nonce for failure detection
      expect(res.headers.location).toContain('__preview_token_redirect=');

      // Should set a preview_auth cookie with CHIPS attributes
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const authCookie = Array.isArray(setCookie)
        ? setCookie.find((c: string) => c.startsWith('preview_auth='))
        : setCookie;
      expect(authCookie).toBeDefined();
      expect(authCookie).toContain('preview_auth=');
      expect(authCookie).toContain('HttpOnly');
      expect(authCookie).toContain('SameSite=None');
      expect(authCookie).toContain('Partitioned');
      expect(authCookie).toContain('Path=/');
    });

    it('shows the cookie-blocked fallback page when the redirect returns without the auth cookie', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          requiresAuth: true,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({
          valid: true,
          token: {
            userId: 'user-1',
            tokenType: 'pt',
            version: 1,
          },
        }),
      );

      const redirectRes = await request(server)
        .get('/nested/path?__preview_token=valid-token')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate')
        .redirects(0);

      expect(redirectRes.status).toBe(302);
      expect(redirectRes.headers.location).toContain(
        '__preview_token_redirect=',
      );

      const redirectedLocation = redirectRes.headers.location;
      expect(redirectedLocation).toBeDefined();
      const redirectedUrl = new URL(redirectedLocation!);

      const fallbackRes = await request(server)
        .get(redirectedUrl.pathname + redirectedUrl.search)
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'nested-navigate')
        .redirects(0);

      expect(fallbackRes.status).toBe(200);
      expect(fallbackRes.text).toContain('Blocked Cookie');
      expect(fallbackRes.text).toContain('Open Preview in New Tab');
      expect(fallbackRes.text).toContain("type: 'roomote-load-complete'");
      expect(fallbackRes.text).not.toContain('__preview_token_redirect=');
    });

    it('strips invalid token and falls through to auth redirect', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          requiresAuth: true,
        }),
      );
      // First call: inline token validation (fails)
      // Second call: cookie validation (also fails)
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({ valid: false, reason: 'invalid' }),
      );

      const res = await request(server)
        .get('/page?__preview_token=bad-token&other=keep')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate')
        .redirects(0);

      expect(res.status).toBe(302);
      // Should redirect to auth, not set an auth cookie
      expect(res.headers.location).toContain('/api/auth/preview');
      expect(res.headers.location).not.toContain('__preview_token');
    });

    it('validates token against the resolved cloud job', async () => {
      const { resolveRequest } = await import('../services/resolver');
      const { validateAuthCookieForCloudJob } =
        await import('../services/auth');

      const cloudJob = createMockCloudJob({ id: 42, orgId: 'org-42' });
      vi.mocked(resolveRequest).mockResolvedValue(
        createMockResolvedRequest({
          status: 'active',
          requiresAuth: true,
          cloudJob,
        }),
      );
      vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
        createMockAuthResult({
          valid: true,
          token: {
            userId: 'user-1',
            tokenType: 'pt',
            version: 1,
          },
        }),
      );

      const res = await request(server)
        .get('/?__preview_token=valid-token')
        .set('Host', TEST_HOST)
        .set('sec-fetch-mode', 'navigate')
        .redirects(0);

      expect(res.status).toBe(302);

      // Verify validateAuthCookieForCloudJob was called with the inline token
      expect(validateAuthCookieForCloudJob).toHaveBeenCalledWith(
        'valid-token',
        cloudJob,
      );
    });
  });
});
