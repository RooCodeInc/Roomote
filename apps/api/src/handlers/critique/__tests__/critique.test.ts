import { Hono } from 'hono';
import sharp from 'sharp';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { critique } from '..';

const { mockEnv, logHandlerErrorMock } = vi.hoisted(() => ({
  mockEnv: {
    CRITIQUE_BASE_URL: 'https://critique.example.test/',
    CRITIQUE_API_TOKEN: 'critique-secret-token',
  },
  logHandlerErrorMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));
vi.mock('../../utils', () => ({ logHandlerError: logHandlerErrorMock }));

const runAuth: RunTokenContext = {
  runId: 42,
  userId: 'user-1',
  principal: 'user',
  tokenType: 'run',
  version: 1,
};

const manifest = {
  mode: 'page',
  captures: [
    {
      id: 'capture-1',
      screenshotAssetId: 'screenshot-1',
      domAssetId: 'dom-1',
      viewport: {
        width: 2,
        height: 2,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
      },
      document: { width: 2, height: 2 },
      page: { url: 'https://example.test/page?token=secret', title: 'Example' },
    },
  ],
};

const safeDom = {
  rootNodeId: 'n1',
  nodes: [
    {
      id: 'n1',
      tagName: 'html',
      bounds: { x: 0, y: 0, width: 2, height: 2 },
      styles: { display: 'block' },
      state: { visible: true },
    },
    {
      id: 'n2',
      parentId: 'n1',
      tagName: 'body',
      text: 'Visible text',
      attributes: { 'aria-label': 'Main' },
      bounds: { x: 0, y: 0, width: 2, height: 2 },
      styles: { display: 'block' },
      state: { visible: true },
    },
  ],
};

let validPng: Buffer;

function createApp(authContext: Variables['authContext'] = runAuth) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (authContext) c.set('authContext', authContext);
    await next();
  });
  app.route('/critique', critique);
  return app;
}

function validRequest(
  options: {
    dom?: unknown;
    input?: unknown;
    screenshot?: Buffer;
    extraPart?: boolean;
  } = {},
) {
  const form = new FormData();
  form.set('input', JSON.stringify(options.input ?? manifest));
  form.set(
    'screenshot-1',
    new File([Uint8Array.from(options.screenshot ?? validPng)], 'capture.png', {
      type: 'image/png',
    }),
  );
  form.set(
    'dom-1',
    new File([JSON.stringify(options.dom ?? safeDom)], 'capture.json', {
      type: 'application/json',
    }),
  );
  if (options.extraPart) form.set('extra', 'not allowed');
  return new Request('http://localhost/critique', {
    method: 'POST',
    body: form,
  });
}

describe('Critique proxy', () => {
  beforeAll(async () => {
    validPng = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.CRITIQUE_BASE_URL = 'https://critique.example.test/';
    mockEnv.CRITIQUE_API_TOKEN = 'critique-secret-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sanitizes and reconstructs the multipart request before forwarding', async () => {
    const partial = {
      status: 'partial',
      findings: [{ id: 'f1', verdict: 'fail', confidence: 0.91 }],
      omittedFindingCount: 3,
      errors: [{ code: 'rule_timeout' }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(partial), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const unsafeDom = structuredClone(safeDom);
    Object.assign(unsafeDom.nodes[1]!, {
      text: 'token=should-not-leave',
      attributes: {
        'aria-label': 'Main',
        href: 'https://secret.test',
        onclick: 'steal()',
        'data-secret': 'hidden',
      },
      styles: {
        display: 'block',
        transform: 'rotate(1deg)',
        'background-image': 'url(https://secret.test/value)',
      },
    });
    const screenshotWithTrailer = Buffer.concat([
      validPng,
      Buffer.from('SECRET_TRAILER'),
    ]);

    const response = await createApp().request(
      validRequest({ dom: unsafeDom, screenshot: screenshotWithTrailer }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(partial);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://critique.example.test/v1/critiques');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer critique-secret-token',
    });
    const forwarded = await new Request('http://upstream.test', {
      method: 'POST',
      headers: {
        'content-type': (init.headers as Record<string, string>)[
          'content-type'
        ]!,
      },
      body: init.body,
    }).formData();
    expect([...forwarded.keys()]).toEqual(['input', 'screenshot-1', 'dom-1']);
    const forwardedManifest = JSON.parse(String(forwarded.get('input')));
    expect(forwardedManifest.captures[0].page.url).toBe(
      'https://example.test/page',
    );
    const forwardedDom = JSON.parse(
      await (forwarded.get('dom-1') as File).text(),
    );
    expect(forwardedDom.nodes[1]).not.toHaveProperty('text');
    expect(forwardedDom.nodes[1].attributes).toEqual({ 'aria-label': 'Main' });
    expect(forwardedDom.nodes[1].styles).toEqual({ display: 'block' });
    const forwardedPng = Buffer.from(
      await (forwarded.get('screenshot-1') as File).arrayBuffer(),
    );
    expect(forwardedPng.includes(Buffer.from('SECRET_TRAILER'))).toBe(false);
    await expect(sharp(forwardedPng).metadata()).resolves.toMatchObject({
      format: 'png',
      width: 2,
      height: 2,
    });
  });

  it.each([
    [422, 400, 'rejected the capture or input'],
    [502, 502, 'service is unavailable'],
    [503, 503, 'service is unavailable'],
  ])(
    'maps upstream %i accurately without retrying',
    async (upstreamStatus, expectedStatus, expectedMessage) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: `upstream ${mockEnv.CRITIQUE_API_TOKEN}` }),
            { status: upstreamStatus },
          ),
        );
      vi.stubGlobal('fetch', fetchMock);

      const response = await createApp().request(validRequest());
      const payload = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(expectedStatus);
      expect(payload.error).toContain(expectedMessage);
      expect(payload.upstreamStatus).toBe(upstreamStatus);
      expect(payload.detail).toContain('[REDACTED]');
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('times out once after at least 150 seconds and warns against retry', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => {
        expect(ms).toBeGreaterThanOrEqual(150_000);
        const controller = new AbortController();
        queueMicrotask(() => controller.abort());
        return controller.signal;
      });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApp().request(validRequest());
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(504);
    expect(payload.error).toContain('must not be retried automatically');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(160_000);
  });

  it('rejects malformed, extra, and disconnected task data before upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const malformed = await createApp().request(
      new Request('http://localhost/critique', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=bad' },
        body: 'arbitrary-task-data',
      }),
    );
    expect(malformed.status).toBe(400);

    const extra = await createApp().request(validRequest({ extraPart: true }));
    expect(extra.status).toBe(400);

    const disconnectedDom = structuredClone(safeDom);
    disconnectedDom.nodes[1]!.parentId = 'missing';
    const disconnected = await createApp().request(
      validRequest({ dom: disconnectedDom }),
    );
    expect(disconnected.status).toBe(400);

    const scriptDom = structuredClone(safeDom);
    scriptDom.nodes[1]!.tagName = 'script';
    const script = await createApp().request(validRequest({ dom: scriptDom }));
    expect(script.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-run auth and oversized payloads before upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const memberResponse = await createApp({
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    }).request(validRequest());
    expect(memberResponse.status).toBe(403);

    const oversizedResponse = await createApp().request(
      new Request('http://localhost/critique', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=test',
          'content-length': String(32 * 1024 * 1024 + 1),
        },
        body: 'small',
      }),
    );
    expect(oversizedResponse.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
