import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const { mockResolveVoiceOpenAiKey, mockCreateVoiceLiveSession } = vi.hoisted(
  () => ({
    mockResolveVoiceOpenAiKey: vi.fn(),
    mockCreateVoiceLiveSession: vi.fn(),
  }),
);

vi.mock('@/lib/server/voice', () => ({
  resolveVoiceOpenAiKey: mockResolveVoiceOpenAiKey,
  createVoiceLiveSession: mockCreateVoiceLiveSession,
}));

import { createVoiceLiveSessionCommand, getVoiceStatusCommand } from '.';

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
      createVoiceLiveSessionCommand({ sdp: 'offer-sdp' }),
    ).resolves.toEqual({
      sessionId: 'live_abc',
      sdp: 'answer-sdp',
    });
    expect(mockCreateVoiceLiveSession).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      sdp: 'offer-sdp',
    });
  });

  it('refuses when voice is not configured', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue(undefined);

    await expect(
      createVoiceLiveSessionCommand({ sdp: 'offer-sdp' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockCreateVoiceLiveSession).not.toHaveBeenCalled();
  });

  it('maps upstream failures to BAD_GATEWAY without leaking details', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCreateVoiceLiveSession.mockRejectedValue(new Error('status 500'));

    const error = await createVoiceLiveSessionCommand({
      sdp: 'offer-sdp',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_GATEWAY');
    expect((error as TRPCError).message).toBe(
      'Failed to start a voice session',
    );
  });
});
