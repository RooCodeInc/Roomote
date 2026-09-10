import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanVoiceTranscript, createVoiceLiveSession } from './voice';
import type { VoiceWorkspaceContext } from './voice-context';

const context: VoiceWorkspaceContext = {
  repositoryNames: ['RooCodeInc/Roomote'],
  environments: [{ name: 'Roomote', repositoryNames: ['RooCodeInc/Roomote'] }],
  integrationNames: ['GitHub'],
};

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
      createVoiceLiveSession({ apiKey: 'sk-test', sdp: 'offer-sdp', context }),
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
    const body = JSON.parse(String(request.body)) as {
      session: { instructions: string };
    };
    expect(body).toMatchObject({
      session: {
        model: 'gpt-live-1',
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: 'offer-sdp' },
    });
    // GPT-Live must know what the backend can reach so a repository name is
    // delegated instead of questioned.
    expect(body.session.instructions).toContain('RooCodeInc/Roomote');
    expect(body.session.instructions).toContain(
      'Integrations the backend can use: GitHub.',
    );
  });

  it('rejects an incomplete Live response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 201 })),
    );

    await expect(
      createVoiceLiveSession({ apiKey: 'sk-test', sdp: 'offer-sdp', context }),
    ).rejects.toThrow('OpenAI Live session response was incomplete');
  });
});

describe('cleanVoiceTranscript', () => {
  it('gives the cleanup model the workspace names as vocabulary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Open the Roomote repo.' },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      cleanVoiceTranscript({
        apiKey: 'sk-test',
        text: 'um open the the room oat repo',
        context,
      }),
    ).resolves.toBe('Open the Roomote repo.');

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      model: string;
      instructions: string;
      input: string;
    };
    expect(body.model).toBe('gpt-5.4-mini');
    expect(body.input).toBe('um open the the room oat repo');
    expect(body.instructions).toContain('- RooCodeInc/Roomote');
    expect(body.instructions).toContain('- GitHub');
  });
});
