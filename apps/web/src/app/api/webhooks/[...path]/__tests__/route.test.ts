import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

import { POST } from '../route';

const mockBootstrapWebRuntimeEnv = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

describe('POST /api/webhooks/[...path]', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockBootstrapWebRuntimeEnv.mockReset();
  });

  it('forwards to a pathful API base URL without dropping the prefix', async () => {
    mockBootstrapWebRuntimeEnv.mockResolvedValue({
      TRPC_URL: 'https://app.roomote.test/_roomote-api',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('accepted', {
        status: 202,
        headers: {
          connection: 'close',
          'x-api': 'ok',
        },
      }),
    );
    const request = new NextRequest(
      'https://app.roomote.test/api/webhooks/slack?challenge=1',
      {
        method: 'POST',
        headers: {
          connection: 'keep-alive',
          'content-type': 'application/json',
          host: 'app.roomote.test',
        },
        body: JSON.stringify({ type: 'event_callback' }),
      },
    );

    const response = await POST(request, {
      params: { path: ['slack'] },
    });

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(
      'https://app.roomote.test/_roomote-api/api/webhooks/slack?challenge=1',
    );
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
    const forwardedHeaders = init?.headers as Headers;
    expect(forwardedHeaders.get('content-type')).toBe('application/json');
    expect(forwardedHeaders.get('x-forwarded-host')).toBe('app.roomote.test');
    expect(forwardedHeaders.get('x-forwarded-proto')).toBe('https');
    expect(forwardedHeaders.has('connection')).toBe(false);
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(
      JSON.stringify({ type: 'event_callback' }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('x-api')).toBe('ok');
    expect(response.headers.has('connection')).toBe(false);
  });

  it('drops the Expect header Azure DevOps sends before forwarding', async () => {
    mockBootstrapWebRuntimeEnv.mockResolvedValue({
      TRPC_URL: 'https://app.roomote.test/_roomote-api',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const request = new NextRequest(
      'https://app.roomote.test/api/webhooks/ado',
      {
        method: 'POST',
        headers: {
          expect: '100-continue',
          'content-type': 'application/json',
          'x-roomote-webhook-secret': 'secret',
        },
        body: JSON.stringify({ eventType: 'git.pullrequest.created' }),
      },
    );

    const response = await POST(request, {
      params: { path: ['ado'] },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const forwardedHeaders = init?.headers as Headers;
    expect(forwardedHeaders.has('expect')).toBe(false);
    expect(forwardedHeaders.get('x-roomote-webhook-secret')).toBe('secret');
    expect(response.status).toBe(200);
  });

  it.each([200, 400, 401, 413, 429, 503])(
    'forwards unsigned-by-Roomote Granola callbacks byte-for-byte and preserves status %s',
    async (status) => {
      mockBootstrapWebRuntimeEnv.mockResolvedValue({
        TRPC_URL: 'http://api.test',
      });
      const triggerId = '4fc1c541-c79e-435b-b120-572532ff8157';
      // Whitespace, CRLF and a multibyte metadata value must survive forwarding.
      const body = Buffer.from(
        '{\r\n  "event_id": "evt_123", "metadata": "caf\u00e9"\r\n}\n',
      );
      const id = 'evt_123';
      const timestamp = '1788900000';
      const key = Buffer.from('test-granola-key');
      const signature = createHmac('sha256', key)
        .update(`${id}.${timestamp}.`)
        .update(body)
        .digest('base64');
      const signatures = `v1,${Buffer.alloc(32).toString('base64')} v1,${signature}`;
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{"status":"upstream"}', { status }));
      const request = new NextRequest(
        `https://public.roomote.test/api/webhooks/automations/${triggerId}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(body.length),
            'webhook-id': id,
            'webhook-timestamp': timestamp,
            'webhook-signature': signatures,
          },
          body,
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ path: ['automations', triggerId] }),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [target, init] = fetchMock.mock.calls[0]!;
      expect(String(target)).toBe(
        `http://api.test/api/webhooks/automations/${triggerId}`,
      );
      const headers = init?.headers as Headers;
      expect(headers.get('webhook-id')).toBe(id);
      expect(headers.get('webhook-timestamp')).toBe(timestamp);
      expect(headers.get('webhook-signature')).toBe(signatures);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('content-length')).toBe(false);
      const forwardedBody = Buffer.from(init?.body as ArrayBuffer);
      expect(forwardedBody).toEqual(body);
      expect(
        createHmac('sha256', key)
          .update(
            `${headers.get('webhook-id')}.${headers.get('webhook-timestamp')}.`,
          )
          .update(forwardedBody)
          .digest('base64'),
      ).toBe(signature);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('{"status":"upstream"}');
    },
  );
});
