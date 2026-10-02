import { Hono } from 'hono';
import sharp from 'sharp';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { critique } from '..';

const mocks = vi.hoisted(() => ({
  env: {
    CRITIQUE_BASE_URL: 'https://critique.example.test/',
    CRITIQUE_API_TOKEN: 'critique-secret-token',
  },
  findRun: vi.fn(),
  redisEval: vi.fn(),
  rpc: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: mocks.env }));
vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  eq: vi.fn(),
  taskRuns: { id: 'id' },
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mocks.redisEval }),
}));
vi.mock('@roomote/sdk/server', () => ({
  withSandboxServerRpcClient: mocks.rpc,
}));
vi.mock('../../utils', () => ({ logHandlerError: mocks.log }));

const runAuth: RunTokenContext = {
  runId: 42,
  userId: 'user-1',
  principal: 'user',
  tokenType: 'run',
  version: 1,
};

const record = {
  id: 'capture-1',
  screenshotAssetId: 'screenshot-1',
  domAssetId: 'dom-1',
  screenshotPath: '/tmp/removed.png',
  domPath: '/tmp/removed.json',
  viewport: {
    width: 2,
    height: 2,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
  },
  document: { width: 2, height: 2 },
  page: { url: 'https://example.test/page?token=secret', title: 'Example' },
  nodeCount: 2,
};
const dom = {
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
      bounds: { x: 0, y: 0, width: 2, height: 2 },
      styles: { display: 'block' },
      state: { visible: true },
    },
  ],
};

let screenshotBase64: string;

function createApp(authContext: Variables['authContext'] = runAuth) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (authContext) c.set('authContext', authContext);
    await next();
  });
  app.route('/critique', critique);
  return app;
}

function request(body: unknown) {
  return new Request('http://localhost/critique', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Critique proxy', () => {
  beforeAll(async () => {
    screenshotBase64 = (
      await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 10, g: 20, b: 30, alpha: 1 },
        },
      })
        .png()
        .toBuffer()
    ).toString('base64');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-1',
      sandboxServerUrl: 'http://sandbox.test',
    });
    mocks.redisEval.mockResolvedValue(1);
    mocks.rpc.mockImplementation(async ({ call }) =>
      call({
        commands: {
          critiqueCapture: {
            mutate: vi.fn(async (input) =>
              input.action === 'capture'
                ? { action: 'capture', capture: record }
                : {
                    action: 'read',
                    captures: [
                      {
                        record,
                        screenshotBase64,
                        domJson: JSON.stringify(dom),
                      },
                    ],
                  },
            ),
          },
        },
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('captures through the control-plane-only sandbox RPC', async () => {
    const response = await createApp().request(request({ action: 'capture' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: 'capture',
      capture: { id: 'capture-1' },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: 'sandbox-control', runId: 42 }),
    );
  });

  it('accepts only capture IDs and builds the paid multipart from worker bytes', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'completed', findings: [] })),
      );
    vi.stubGlobal('fetch', upstream);

    const response = await createApp().request(
      request({ action: 'review', captureIds: ['capture-1'] }),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const init = upstream.mock.calls[0]?.[1] as RequestInit;
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
    expect(
      JSON.parse(String(forwarded.get('input'))).captures[0].page.url,
    ).toBe('https://example.test/page');
  });

  it('rejects task-supplied image and DOM fields before capture RPC', async () => {
    const response = await createApp().request(
      request({
        action: 'review',
        captureIds: ['capture-1'],
        screenshot: screenshotBase64,
        dom,
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('fails closed when the paid-call quota backend is unavailable', async () => {
    mocks.redisEval.mockRejectedValueOnce(new Error('redis unavailable'));
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await createApp().request(
      request({ action: 'review', captureIds: ['capture-1'] }),
    );
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns 429 after two paid calls for the run', async () => {
    mocks.redisEval.mockResolvedValueOnce(3);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await createApp().request(
      request({ action: 'review', captureIds: ['capture-1'] }),
    );
    expect(response.status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });
});
