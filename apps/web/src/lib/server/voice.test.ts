import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateTrackedNonTaskText } = vi.hoisted(() => ({
  generateTrackedNonTaskText: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES: {
    voiceTranscriptCleanup: 'voice_transcript_cleanup',
  },
}));

const { resolveModelProviderEnvValue, findConnection, findEnablement } =
  vi.hoisted(() => ({
    resolveModelProviderEnvValue: vi.fn(),
    findConnection: vi.fn(),
    findEnablement: vi.fn(),
  }));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  resolveModelProviderEnvValue,
  db: {
    query: {
      mcpConnections: { findFirst: findConnection },
      deploymentMcpEnablements: { findFirst: findEnablement },
    },
  },
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

vi.mock('./env', () => ({
  Env: { R_CURATED_INTEGRATIONS_DISABLED: undefined },
  areCuratedIntegrationsDisabled: () => false,
}));

import {
  cleanVoiceTranscript,
  createVoiceLiveSession,
  createVoicePreview,
  VoicePreviewPermissionError,
  resolveVoiceOpenAiKey,
  resolveVoiceId,
} from './voice';
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
  it('creates a GPT-Live WebRTC session with nested voice config and client delegation', async () => {
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
        voiceId: 'cedar',
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
        audio: { output: { voice: 'cedar' } },
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: 'offer-sdp' },
    });
    expect(body.session).not.toHaveProperty('voice');
    // GPT-Live must know what the backend can reach so a repository name is
    // delegated instead of questioned.
    expect(body.session.instructions).toContain('RooCodeInc/Roomote');
    expect(body.session.instructions).toContain(
      'Integrations the backend can use: GitHub.',
    );
    // The voice acknowledges, delegates every utterance, and reports results
    // faithfully without originating answers or claims of inspection.
    expect(body.session.instructions).toContain('Backchannel policy');
    expect(body.session.instructions).toContain(
      'Delegate every complete utterance to the backend',
    );
    expect(body.session.instructions).toContain(
      'Never answer, explain, clarify, offer an opinion, or state a fact yourself',
    );
    expect(body.session.instructions).toContain(
      'Never claim that you checked a source',
    );
    expect(body.session.instructions).toContain(
      'any product, repository, or connected tool discussed in the Session',
    );
    expect(body.session.instructions).toContain(
      'Roomote when the platform itself is the topic',
    );
    expect(body.session.instructions).not.toContain(
      'describe how Roomote works',
    );
    expect(body.session.instructions).not.toContain(
      'Do not delegate to the backend when',
    );
    expect(body.session.instructions).toContain(
      'keep every number, name, path, and link label exactly as given',
    );
  });

  it('creates a short preview through OpenAI speech with the selected voice', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createVoicePreview({ apiKey: 'sk-test', voiceId: 'marin' }),
    ).resolves.toEqual({ audioBase64: 'AQID', mimeType: 'audio/mpeg' });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/audio/speech',
    );
    expect(JSON.parse(String(request.body))).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: "Hi, I'm Roomote. Let's build something great.",
      response_format: 'mp3',
    });
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
        voiceId: 'marin',
      }),
    ).rejects.toThrow('OpenAI Live session response was incomplete');
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

describe('resolveVoiceOpenAiKey', () => {
  beforeEach(() => {
    resolveModelProviderEnvValue.mockReset();
    findConnection.mockReset();
    findEnablement.mockReset();
  });

  it('reads the Settings-managed key fresh on every call so saves and disconnects apply at once', async () => {
    resolveModelProviderEnvValue.mockResolvedValue(undefined);
    findConnection.mockResolvedValueOnce(null);
    await expect(resolveVoiceOpenAiKey()).resolves.toBeUndefined();

    // The admin saves a key: the next call sees it, no cache window.
    findConnection.mockResolvedValueOnce({
      authConfig: { type: 'voice', encryptedApiKey: 'enc:sk-voice' },
    });
    findEnablement.mockResolvedValueOnce({ enabled: true });
    await expect(resolveVoiceOpenAiKey()).resolves.toBe('sk-voice');

    // The admin disconnects: the next call no longer has it.
    findConnection.mockResolvedValueOnce(null);
    await expect(resolveVoiceOpenAiKey()).resolves.toBeUndefined();
  });

  it('prefers the environment key and ignores a disabled stored connection', async () => {
    resolveModelProviderEnvValue.mockResolvedValueOnce(' sk-env ');
    await expect(resolveVoiceOpenAiKey()).resolves.toBe('sk-env');
    expect(findConnection).not.toHaveBeenCalled();
  });
});

describe('resolveVoiceId', () => {
  beforeEach(() => {
    resolveModelProviderEnvValue.mockReset();
    resolveModelProviderEnvValue.mockResolvedValue(undefined);
    findConnection.mockReset();
  });

  it('uses the visible default when the environment manages the Voice key', async () => {
    resolveModelProviderEnvValue.mockResolvedValue('sk-env');
    findConnection.mockResolvedValue({
      authConfig: {
        type: 'voice',
        encryptedApiKey: 'enc:key',
        voiceId: 'cedar',
      },
    });

    await expect(resolveVoiceId()).resolves.toBe('marin');
    expect(findConnection).not.toHaveBeenCalled();
  });

  it('preserves a stored voice selection', async () => {
    findConnection.mockResolvedValue({
      authConfig: {
        type: 'voice',
        encryptedApiKey: 'enc:key',
        voiceId: 'cedar',
      },
    });

    await expect(resolveVoiceId()).resolves.toBe('cedar');
  });

  it('uses the provider-recommended default for legacy and new configurations', async () => {
    findConnection.mockResolvedValue({
      authConfig: { type: 'voice', encryptedApiKey: 'enc:key' },
    });
    await expect(resolveVoiceId()).resolves.toBe('marin');

    findConnection.mockResolvedValue(null);
    await expect(resolveVoiceId()).resolves.toBe('marin');
  });
});

describe('createVoicePreview permission errors', () => {
  it('names the missing Audio permission when a restricted key is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message:
                'You have insufficient permissions for this operation. Missing scopes: api.model.audio.request.',
              type: 'invalid_request_error',
              code: 'missing_scope',
            },
          }),
          { status: 401 },
        ),
      ),
    );

    await expect(
      createVoicePreview({ apiKey: 'sk-restricted', voiceId: 'marin' }),
    ).rejects.toBeInstanceOf(VoicePreviewPermissionError);
  });
});
