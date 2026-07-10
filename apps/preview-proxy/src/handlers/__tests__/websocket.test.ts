import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type httpProxy from 'http-proxy';

import {
  TEST_TASK_ID,
  createMockAuthResult,
  createMockCloudJob,
  createMockResolvedRequest,
  mockConfig,
} from '../../__tests__/fixtures';

vi.mock('../../config', () => ({
  config: mockConfig,
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  escapeForLog: (s: string) => s,
}));

vi.mock('../../services/resolver', () => ({
  resolveRequest: vi.fn(),
}));

vi.mock('../../services/auth', () => ({
  validateAuthCookieForCloudJob: vi.fn(),
}));

vi.mock('../../lib/nested-routing', () => ({
  tryNestedFallback: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lib/url-parser', () => ({
  parseHostForConfig: vi.fn(),
  stripSuffixFromHost: vi.fn((host: string) => host),
}));

vi.mock('../../lib/proxy', () => ({
  proxyWebSocket: vi.fn(),
}));

vi.mock('../../lib/access-log', () => ({
  emitWsAccessLog: vi.fn(),
}));

import { resolveRequest } from '../../services/resolver';
import { validateAuthCookieForCloudJob } from '../../services/auth';
import { parseHostForConfig, stripSuffixFromHost } from '../../lib/url-parser';
import { proxyWebSocket } from '../../lib/proxy';
import {
  getProxiedWebSocketOrigin,
  handleWebSocketUpgrade,
} from '../websocket';

function createMockSocket(): Socket {
  return {
    on: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  } as unknown as Socket;
}

function createWsRequest(
  headers: Record<string, string | undefined>,
  url = '/socket',
): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: Object.fromEntries(
      Object.entries(headers).filter(([, value]) => value !== undefined),
    ),
  } as unknown as IncomingMessage;
}

describe('handleWebSocketUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.PREVIEW_PROXY_SUBDOMAIN_SUFFIX = undefined;

    vi.mocked(parseHostForConfig).mockReturnValue({
      isValid: true,
      portName: 'editor',
      taskId: TEST_TASK_ID,
    });
  });

  it('preserves browser Origin for routes behind auth-proxy', async () => {
    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        sandboxUrl: 'https://sb-test.vercel.run',
        requiresAuth: false,
        hasAuthProxy: true,
      }),
    );

    const req = createWsRequest({
      host: '20imtw24sm6hv-editor.preview.roomote.run',
      origin: 'https://20imtw24sm6hv-editor.preview.roomote.run',
      'x-forwarded-host': 'should-be-cleared.example',
      'x-forwarded-proto': 'https',
    });
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
    expect(req.headers.origin).toBe(
      'https://20imtw24sm6hv-editor.preview.roomote.run',
    );
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    expect(req.headers['x-roomote-forwarded-host']).toBe(
      '20imtw24sm6hv-editor.preview.roomote.run',
    );
  });

  it('preserves browser origins for direct auth-proxy routes', () => {
    expect(
      getProxiedWebSocketOrigin({
        currentOrigin: 'https://app.roomote.run',
        hasAuthProxy: true,
        host: '20imtw24sm6hv-editor.preview.roomote.run',
        sandboxUrl: 'https://sb-test.vercel.run',
        suffix: undefined,
        wildcardPrefix: false,
        protocol: 'https',
      }),
    ).toBe('https://app.roomote.run');
  });

  it('uses sandbox Origin for wildcard auth-proxy routes', async () => {
    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        sandboxUrl: 'https://sb-test.vercel.run',
        requiresAuth: false,
        hasAuthProxy: true,
        wildcardPrefix: true,
      }),
    );

    const req = createWsRequest({
      host: '20imtw24sm6hv-web-outertask-preview.preview.roomote.run',
      origin: 'https://20imtw24sm6hv-web-outertask-preview.preview.roomote.run',
      'x-forwarded-proto': 'https',
    });
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
    expect(req.headers.origin).toBe('https://sb-test.vercel.run');
    expect(req.headers['x-roomote-forwarded-host']).toBe(
      '20imtw24sm6hv-web-outertask-preview.preview.roomote.run',
    );
  });

  it('keeps legacy sandbox Origin rewrite for routes without auth-proxy', async () => {
    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        sandboxUrl: 'https://sb-test.vercel.run',
        requiresAuth: false,
        hasAuthProxy: false,
      }),
    );

    const req = createWsRequest({
      host: '20imtw24sm6hv-web.preview.roomote.run',
      origin: 'https://20imtw24sm6hv-web.preview.roomote.run',
    });
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
    expect(req.headers.origin).toBe('https://sb-test.vercel.run');
  });

  it('keeps nested forwarding headers intact in inner mode', async () => {
    mockConfig.PREVIEW_PROXY_SUBDOMAIN_SUFFIX = 'outertask-preview';

    vi.mocked(stripSuffixFromHost).mockReturnValue(
      '20imtw24sm6hv-editor.preview.roomote.run',
    );
    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        sandboxUrl: 'https://sb-test.vercel.run',
        requiresAuth: false,
        hasAuthProxy: true,
      }),
    );

    const nestedHost =
      '20imtw24sm6hv-editor-outertask-preview.preview.roomote.run';
    const req = createWsRequest({
      host: 'sandbox-internal-host',
      'x-roomote-forwarded-host': nestedHost,
      origin: `https://${nestedHost}`,
    });
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
    expect(req.headers.origin).toBe(`https://${nestedHost}`);
    expect(req.headers['x-roomote-forwarded-host']).toBe(
      '20imtw24sm6hv-editor.preview.roomote.run',
    );
    expect(req.headers['x-roomote-public-host']).toBe(nestedHost);
  });

  it('restores forwarded public Origin in inner mode after wildcard hop', async () => {
    mockConfig.PREVIEW_PROXY_SUBDOMAIN_SUFFIX = 'outertask-preview';

    vi.mocked(stripSuffixFromHost).mockReturnValue(
      '20imtw24sm6hv-editor.preview.roomote.run',
    );
    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        status: 'active',
        sandboxUrl: 'https://sb-test.vercel.run',
        requiresAuth: false,
        hasAuthProxy: true,
      }),
    );

    const nestedHost =
      '20imtw24sm6hv-editor-outertask-preview.preview.roomote.run';
    const req = createWsRequest({
      host: 'sandbox-internal-host',
      'x-roomote-forwarded-host': nestedHost,
      origin: 'https://sb-test.vercel.run',
      'x-forwarded-proto': 'https',
    });
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
    expect(req.headers.origin).toBe(`https://${nestedHost}`);
    expect(req.headers['x-roomote-forwarded-host']).toBe(
      '20imtw24sm6hv-editor.preview.roomote.run',
    );
    expect(req.headers['x-roomote-public-host']).toBe(nestedHost);
  });

  it('accepts inline preview tokens for auth-protected websocket upgrades from the app shell', async () => {
    const cloudJob = createMockCloudJob({ actingUserId: 'user-1' });

    vi.mocked(parseHostForConfig).mockReturnValue({
      isValid: true,
      portName: 'editor',
      taskId: TEST_TASK_ID,
    });

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        cloudJob,
        hasAuthProxy: true,
        requestedPortKey: 'EDITOR',
        requiresAuth: true,
        sandboxUrl: 'https://sb-test.vercel.run',
        status: 'active',
      }),
    );
    vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
      createMockAuthResult({
        token: {
          userId: 'user-1',
          tokenType: 'pt',
          version: 1,
        },
        valid: true,
      }),
    );

    const req = createWsRequest(
      {
        cookie: 'other=value',
        host: '20imtw24sm6hv-editor.preview.roomote.run',
        origin: 'https://app.roomote.run',
        'x-forwarded-proto': 'https',
      },
      '/websockify?__preview_token=inline-token&keep=1',
    );
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(validateAuthCookieForCloudJob).toHaveBeenCalledWith(
      'inline-token',
      cloudJob,
    );
    expect(req.url).toBe('/websockify?keep=1');
    expect(req.headers.cookie).toContain('other=value');
    expect(req.headers.cookie).toContain('preview_auth=inline-token');
    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid inline preview tokens when no auth cookie exists', async () => {
    const cloudJob = createMockCloudJob();

    vi.mocked(resolveRequest).mockResolvedValue(
      createMockResolvedRequest({
        cloudJob,
        hasAuthProxy: true,
        requiresAuth: true,
        sandboxUrl: 'https://sb-test.vercel.run',
        status: 'active',
      }),
    );
    vi.mocked(validateAuthCookieForCloudJob).mockResolvedValue(
      createMockAuthResult({ valid: false }),
    );

    const req = createWsRequest(
      {
        host: '20imtw24sm6hv-editor.preview.roomote.run',
        origin: 'https://20imtw24sm6hv-editor.preview.roomote.run',
      },
      '/socket?__preview_token=bad-token',
    );
    const socket = createMockSocket();

    await handleWebSocketUpgrade(
      req,
      socket,
      Buffer.alloc(0),
      {} as unknown as httpProxy,
    );

    expect(req.url).toBe('/socket');
    expect(proxyWebSocket).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(
      'HTTP/1.1 401 Unauthorized\r\n\r\n',
    );
  });
});
