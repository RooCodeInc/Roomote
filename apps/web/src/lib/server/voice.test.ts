import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceLiveSession } from './voice';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createVoiceLiveSession', () => {
  it('creates a GPT-Live WebRTC session with client delegation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          session: { id: 'live_123' },
          transport: { type: 'webrtc', sdp: 'answer-sdp' },
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createVoiceLiveSession({ apiKey: 'sk-test', sdp: 'offer-sdp' }),
    ).resolves.toEqual({ sessionId: 'live_123', sdp: 'answer-sdp' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/live/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer sk-test',
          'content-type': 'application/json',
        },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      session: {
        model: 'gpt-live-1',
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: 'offer-sdp' },
    });
  });

  it('rejects an incomplete Live response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 201 })),
    );

    await expect(
      createVoiceLiveSession({ apiKey: 'sk-test', sdp: 'offer-sdp' }),
    ).rejects.toThrow('OpenAI Live session response was incomplete');
  });
});
