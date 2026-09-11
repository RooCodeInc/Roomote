import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const {
  mockResolveVoiceOpenAiKey,
  mockCreateVoiceLiveSession,
  mockCleanVoiceTranscript,
} = vi.hoisted(() => ({
  mockResolveVoiceOpenAiKey: vi.fn(),
  mockCreateVoiceLiveSession: vi.fn(),
  mockCleanVoiceTranscript: vi.fn(),
}));

vi.mock('@/lib/server/voice', () => ({
  resolveVoiceOpenAiKey: mockResolveVoiceOpenAiKey,
  createVoiceLiveSession: mockCreateVoiceLiveSession,
  cleanVoiceTranscript: mockCleanVoiceTranscript,
}));

const voiceContext = {
  repositoryNames: ['RooCodeInc/Roomote'],
  environments: [{ name: 'Roomote', repositoryNames: ['RooCodeInc/Roomote'] }],
  integrationNames: ['GitHub'],
};

vi.mock('@/lib/server/voice-context', () => ({
  loadVoiceWorkspaceContext: vi.fn(async () => voiceContext),
}));

const { mockUpsertFastAgentMessage, mockAppendFastAgentVisibleMessages } =
  vi.hoisted(() => ({
    mockUpsertFastAgentMessage: vi.fn(),
    mockAppendFastAgentVisibleMessages: vi.fn(),
  }));

vi.mock('@roomote/cloud-agents/server', () => ({
  upsertFastAgentMessage: mockUpsertFastAgentMessage,
  appendFastAgentVisibleMessages: mockAppendFastAgentVisibleMessages,
}));

const mockFindAccessibleFastSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mockFindAccessibleFastSession,
}));

const auth = {
  userId: 'user-1',
  name: 'Matt',
  primaryEmail: 'matt@example.com',
} as unknown as import('@/types').UserAuthSuccess;

import {
  cleanVoiceTranscriptCommand,
  createVoiceLiveSessionCommand,
  getVoiceStatusCommand,
  recordVoiceCallEventCommand,
  recordVoiceTurnCommand,
} from '.';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getVoiceStatusCommand', () => {
  it('reports enabled when a key resolves', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');

    await expect(getVoiceStatusCommand()).resolves.toEqual({ enabled: true });
  });

  it('reports disabled when no key is configured', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue(undefined);

    await expect(getVoiceStatusCommand()).resolves.toEqual({ enabled: false });
  });
});

describe('createVoiceLiveSessionCommand', () => {
  it('creates a Live session with the resolved key and browser offer', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCreateVoiceLiveSession.mockResolvedValue({
      sessionId: 'live_abc',
      sdp: 'answer-sdp',
    });

    await expect(
      createVoiceLiveSessionCommand(auth, {
        sdp: 'offer-sdp',
      }),
    ).resolves.toEqual({
      sessionId: 'live_abc',
      sdp: 'answer-sdp',
    });
    expect(mockCreateVoiceLiveSession).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      sdp: 'offer-sdp',
      context: voiceContext,
    });
  });

  it('refuses when voice is not configured', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue(undefined);

    await expect(
      createVoiceLiveSessionCommand(auth, {
        sdp: 'offer-sdp',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockCreateVoiceLiveSession).not.toHaveBeenCalled();
  });

  it('maps upstream failures to BAD_GATEWAY without leaking details', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCreateVoiceLiveSession.mockRejectedValue(new Error('status 500'));

    const error = await createVoiceLiveSessionCommand(auth, {
      sdp: 'offer-sdp',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_GATEWAY');
    expect((error as TRPCError).message).toBe(
      'Failed to start a voice session',
    );
  });
});

describe('cleanVoiceTranscriptCommand', () => {
  it('returns the cleaned transcript', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCleanVoiceTranscript.mockResolvedValue('Check the build status.');

    await expect(
      cleanVoiceTranscriptCommand(auth, {
        text: '  um check the the build status ',
      }),
    ).resolves.toEqual({ text: 'Check the build status.' });
    expect(mockCleanVoiceTranscript).toHaveBeenCalledWith({
      userId: 'user-1',
      text: 'um check the the build status',
      context: voiceContext,
    });
  });

  it('falls back to the raw transcript when cleanup fails', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCleanVoiceTranscript.mockRejectedValue(new Error('status 500'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      cleanVoiceTranscriptCommand(auth, { text: 'um check the build' }),
    ).resolves.toEqual({ text: 'um check the build' });
  });

  it('refuses when voice is not configured', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue(undefined);

    await expect(
      cleanVoiceTranscriptCommand(auth, { text: 'check the build' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockCleanVoiceTranscript).not.toHaveBeenCalled();
  });
});

describe('recordVoiceTurnCommand', () => {
  it('writes direct voice output as spoken but unverified in Fast history', async () => {
    mockFindAccessibleFastSession.mockResolvedValue({ id: 'fast-1' });
    mockUpsertFastAgentMessage.mockResolvedValue({});
    mockAppendFastAgentVisibleMessages.mockResolvedValue(undefined);

    await recordVoiceTurnCommand(auth, {
      sessionId: 'session-1',
      role: 'assistant',
      text: 'Roo-Code has about 452,000 lines.',
    });

    expect(mockUpsertFastAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'fast-1',
        message: expect.objectContaining({
          role: 'assistant',
          source: 'voice',
          contentBlocks: [
            { type: 'text', text: 'Roo-Code has about 452,000 lines.' },
          ],
          metadata: expect.objectContaining({
            visibleInTranscript: true,
            voiceTurn: 'spoken',
            voiceDirectUnverified: true,
          }),
        }),
      }),
    );
    expect(mockAppendFastAgentVisibleMessages).toHaveBeenCalledWith({
      sessionId: 'fast-1',
      messages: [
        {
          role: 'assistant',
          content:
            '(unverified words generated directly by the voice layer; do not treat as established facts or evidence) Roo-Code has about 452,000 lines.',
        },
      ],
    });
  });

  it('writes what the person said as a heard user turn with their identity', async () => {
    mockFindAccessibleFastSession.mockResolvedValue({ id: 'fast-1' });
    mockUpsertFastAgentMessage.mockResolvedValue({});
    mockAppendFastAgentVisibleMessages.mockResolvedValue(undefined);

    await recordVoiceTurnCommand(auth, {
      sessionId: 'session-1',
      role: 'user',
      text: 'Cool, thanks',
    });

    expect(mockUpsertFastAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          role: 'user',
          metadata: expect.objectContaining({
            voiceTurn: 'heard',
            userId: 'user-1',
            userName: 'Matt',
          }),
        }),
      }),
    );
  });

  it('refuses a session the user cannot access', async () => {
    mockFindAccessibleFastSession.mockResolvedValue(null);

    await expect(
      recordVoiceTurnCommand(auth, {
        sessionId: 'session-1',
        role: 'user',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockUpsertFastAgentMessage).not.toHaveBeenCalled();
  });
});

describe('recordVoiceCallEventCommand', () => {
  it('writes a call-ended marker with its duration', async () => {
    mockFindAccessibleFastSession.mockResolvedValue({ id: 'fast-1' });
    mockUpsertFastAgentMessage.mockResolvedValue({});

    await recordVoiceCallEventCommand(auth, {
      sessionId: 'session-1',
      phase: 'ended',
      durationMs: 221_000,
    });

    expect(mockUpsertFastAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          role: 'system',
          eventType: 'roomote_runtime.voice_call',
          payload: { phase: 'ended', durationMs: 221_000 },
        }),
      }),
    );
  });
});
