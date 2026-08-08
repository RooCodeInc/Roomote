import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    R_ELEVENLABS_API_KEY: undefined as string | undefined,
    R_ELEVENLABS_VOICE_ID: undefined as string | undefined,
  },
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
}));

import { tts } from '../index';

function createRunToken(): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
  };
}

function createApp(
  authContext: Variables['authContext'],
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });

  app.route('/tts', tts);
  return app;
}

function narrationRequest(body: unknown): Request {
  return new Request('http://localhost/tts/narration', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockEnv.R_ELEVENLABS_API_KEY = 'el-key';
  mockEnv.R_ELEVENLABS_VOICE_ID = 'voice-1';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('POST /tts/narration', () => {
  it('404s when the deployment has no ElevenLabs credentials', async () => {
    mockEnv.R_ELEVENLABS_API_KEY = undefined;

    const response = await createApp(createRunToken()).request(
      narrationRequest({ lines: ['hello'] }),
    );

    expect(response.status).toBe(404);
  });

  it('404s when only the voice id is missing', async () => {
    mockEnv.R_ELEVENLABS_VOICE_ID = undefined;

    const response = await createApp(createRunToken()).request(
      narrationRequest({ lines: ['hello'] }),
    );

    expect(response.status).toBe(404);
  });

  it('rejects non-run-token callers', async () => {
    const response = await createApp(undefined).request(
      narrationRequest({ lines: ['hello'] }),
    );

    expect(response.status).toBe(403);
  });

  it('rejects invalid line payloads', async () => {
    const app = createApp(createRunToken());

    for (const body of [
      {},
      { lines: [] },
      { lines: ['ok', 42] },
      { lines: ['   '] },
      { lines: ['x'.repeat(1_201)] },
      { lines: Array.from({ length: 25 }, () => 'line') },
    ]) {
      const response = await app.request(narrationRequest(body));

      expect(response.status).toBe(400);
    }
  });

  it('413s a body that exceeds the cap even without content-length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });

    const response = await createApp(createRunToken()).request(
      new Request('http://localhost/tts/narration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: endlessBody,
        // @ts-expect-error duplex is required for stream bodies in undici
        duplex: 'half',
      }),
    );

    expect(response.status).toBe(413);
  });

  it('synthesizes each line through ElevenLabs with the server-held key', async () => {
    const fetchMock = vi.fn(
      async () => new Response(Buffer.from('mp3-bytes'), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const response = await createApp(createRunToken()).request(
      narrationRequest({ lines: ['First line.', 'Second line.'] }),
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      clips: { audioBase64: string }[];
    };

    expect(payload.clips).toHaveLength(2);
    expect(
      Buffer.from(payload.clips[0]!.audioBase64, 'base64').toString(),
    ).toBe('mp3-bytes');

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect(url).toContain('https://api.elevenlabs.io/v1/text-to-speech/');
    expect(url).toContain('voice-1');

    const headers = init.headers as Record<string, string>;

    expect(headers['xi-api-key']).toBe('el-key');

    const body = JSON.parse(String(init.body)) as {
      model_id: string;
      voice_settings: { stability: number };
    };

    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(body.voice_settings.stability).toBe(0.35);
  });

  it('502s when the upstream synthesis fails', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof globalThis.fetch;

    const response = await createApp(createRunToken()).request(
      narrationRequest({ lines: ['hello'] }),
    );

    expect(response.status).toBe(502);

    const payload = (await response.json()) as { error: string };

    // The upstream error body must not leak through.
    expect(payload.error).toBe('Narration synthesis failed');
  });
});
