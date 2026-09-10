import { afterEach, describe, expect, it, vi } from 'vitest';

const { generateTrackedNonTaskText } = vi.hoisted(() => ({
  generateTrackedNonTaskText: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES: {
    voiceTranscriptCleanup: 'voice_transcript_cleanup',
  },
}));

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
      createVoiceLiveSession({
        apiKey: 'sk-test',
        sdp: 'offer-sdp',
        context,
        mode: 'conversation',
      }),
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
    // Replies are read verbatim and every utterance reaches the Session.
    expect(body.session.instructions).toContain('word for word');
    expect(body.session.instructions).toContain(
      'Delegate every single thing the person says',
    );
  });

  it('rejects an incomplete Live response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 201 })),
    );

    await expect(
      createVoiceLiveSession({
        apiKey: 'sk-test',
        sdp: 'offer-sdp',
        context,
        mode: 'conversation',
      }),
    ).rejects.toThrow('OpenAI Live session response was incomplete');
  });

  it('tells a kickoff conversation to delegate the first request silently', async () => {
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

    await createVoiceLiveSession({
      apiKey: 'sk-test',
      sdp: 'offer-sdp',
      context,
      mode: 'kickoff',
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      session: { instructions: string };
    };
    expect(body.session.instructions).toContain('Do not speak at all');
    expect(body.session.instructions).toContain(
      'delegate it to the backend immediately',
    );
  });
});

describe('cleanVoiceTranscript', () => {
  it('runs on the helper model with the workspace names as vocabulary', async () => {
    generateTrackedNonTaskText.mockResolvedValue(' Open the Roomote repo. ');

    await expect(
      cleanVoiceTranscript({
        userId: 'user-1',
        text: 'um open the the room oat repo',
        context,
      }),
    ).resolves.toBe('Open the Roomote repo.');

    expect(generateTrackedNonTaskText).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'voice_transcript_cleanup',
        userId: 'user-1',
        modelRole: 'small',
        prompt: 'um open the the room oat repo',
      }),
    );
    const { system } = generateTrackedNonTaskText.mock.calls[0]![0] as {
      system: string;
    };
    expect(system).toContain('- RooCodeInc/Roomote');
    expect(system).toContain('- GitHub');
  });

  it('rejects an empty cleanup result so the caller falls back to the raw text', async () => {
    generateTrackedNonTaskText.mockResolvedValue('   ');

    await expect(
      cleanVoiceTranscript({ userId: 'user-1', text: 'hello', context }),
    ).rejects.toThrow('Transcript cleanup returned no text');
  });
});
