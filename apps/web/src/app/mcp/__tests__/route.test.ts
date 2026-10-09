import { NextRequest } from 'next/server';

const mockBootstrapWebRuntimeEnv = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

import { GET as GET_METADATA } from '../../.well-known/oauth-protected-resource/mcp/route';
import { DELETE, GET, POST } from '../route';
import { GET as GET_DOWNLOAD } from '../task-outputs/download/route';
import { GET as GET_MODELS } from '../models/route';

describe('public Roomote MCP proxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockBootstrapWebRuntimeEnv.mockResolvedValue({
      R_PUBLIC_URL: 'https://roomote.example',
      R_APP_URL: 'http://localhost:3000',
      TRPC_URL: 'https://api.internal.test/_roomote-api',
    });
  });

  it('forwards the public MCP endpoint to the pathful API base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unauthorized', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://roomote.example/.well-known/oauth-protected-resource/mcp"',
        },
      }),
    );

    const response = await GET(
      new NextRequest('https://roomote.example/mcp', {
        headers: {
          host: 'attacker.example',
          forwarded: 'host=attacker.example',
          'x-forwarded-for': '203.0.113.10',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'http',
        },
      }),
    );

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe('https://api.internal.test/_roomote-api/mcp');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    const forwardedHeaders = init?.headers as Headers;
    expect(forwardedHeaders.has('host')).toBe(false);
    expect(forwardedHeaders.has('forwarded')).toBe(false);
    expect(forwardedHeaders.has('x-forwarded-for')).toBe(false);
    expect(forwardedHeaders.get('x-forwarded-host')).toBe('roomote.example');
    expect(forwardedHeaders.get('x-forwarded-proto')).toBe('https');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://roomote.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('forwards authenticated Streamable HTTP requests and bodies', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    const response = await POST(
      new NextRequest('https://roomote.example/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body,
      }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
    expect(response.status).toBe(200);
  });

  it('forwards public protected-resource discovery to the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        resource: 'https://roomote.example/mcp',
        authorization_servers: ['https://roomote.example'],
      }),
    );

    const response = await GET_METADATA(
      new NextRequest(
        'https://roomote.example/.well-known/oauth-protected-resource/mcp',
      ),
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.internal.test/_roomote-api/.well-known/oauth-protected-resource/mcp',
    );
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://roomote.example/mcp',
    });
  });

  it('forwards model discovery bearer and encoded pagination/filter query to a pathful API base', async () => {
    const body = {
      models: [],
      defaultModelId: 'openai/example',
      nextCursor: null,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(body, {
        headers: { 'cache-control': 'no-store, private' },
      }),
    );
    const query = '?limit=1&query=GPT%20%26%20Claude&cursor=opaque_cursor';
    const response = await GET_MODELS(
      new NextRequest(`https://roomote.example/mcp/models${query}`, {
        headers: {
          authorization: 'Bearer test-account',
          host: 'untrusted.example',
          'x-forwarded-host': 'untrusted.example',
        },
      }),
    );
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(
      `https://api.internal.test/_roomote-api/mcp/models${query}`,
    );
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      body: undefined,
    });
    const headers = init!.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer test-account');
    expect(headers.has('host')).toBe(false);
    expect(headers.get('x-forwarded-host')).toBe('roomote.example');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    await expect(response.json()).resolves.toEqual(body);
  });

  it.each([400, 401, 403])(
    'preserves model discovery HTTP %s and JSON errors',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ error: 'refused' }, { status }),
      );
      const response = await GET_MODELS(
        new NextRequest('https://roomote.example/mcp/models?limit=0'),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: 'refused' });
    },
  );

  it('streams artifact downloads with the existing bearer through a pathful API base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('file bytes', {
        headers: {
          'cache-control': 'private, no-store',
          'content-disposition': 'attachment',
          'content-type': 'application/octet-stream',
        },
      }),
    );
    const response = await GET_DOWNLOAD(
      new NextRequest(
        'https://roomote.example/mcp/task-outputs/download?taskId=abc123def4567&artifactId=artifact',
        {
          headers: { authorization: 'Bearer same-mcp-credential' },
        },
      ),
    );
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(
      'https://api.internal.test/_roomote-api/mcp/task-outputs/download?taskId=abc123def4567&artifactId=artifact',
    );
    expect((init?.headers as Headers).get('authorization')).toBe(
      'Bearer same-mcp-credential',
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    await expect(response.text()).resolves.toBe('file bytes');
  });

  it('streams DELETE responses and preserves MCP session headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('deleted'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'mcp-session-id': 'session-2' } },
      ),
    );

    const response = await DELETE(
      new NextRequest('https://roomote.example/mcp', {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'session-1' },
      }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Headers).get('mcp-session-id')).toBe('session-1');
    expect(response.headers.get('mcp-session-id')).toBe('session-2');
    await expect(response.text()).resolves.toBe('deleted');
  });
});
