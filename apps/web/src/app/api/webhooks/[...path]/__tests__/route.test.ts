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
});
