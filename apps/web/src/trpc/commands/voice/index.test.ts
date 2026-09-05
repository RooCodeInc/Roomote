import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const { mockResolveVoiceOpenAiKey, mockCreateVoiceRealtimeClientSecret } =
  vi.hoisted(() => ({
    mockResolveVoiceOpenAiKey: vi.fn(),
    mockCreateVoiceRealtimeClientSecret: vi.fn(),
  }));

vi.mock('@/lib/server/voice', () => ({
  resolveVoiceOpenAiKey: mockResolveVoiceOpenAiKey,
  createVoiceRealtimeClientSecret: mockCreateVoiceRealtimeClientSecret,
}));

import { createVoiceRealtimeTokenCommand, getVoiceStatusCommand } from '.';

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

describe('createVoiceRealtimeTokenCommand', () => {
  it('mints a token with the resolved key', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCreateVoiceRealtimeClientSecret.mockResolvedValue({
      value: 'ek_abc',
      expiresAt: 1_700_000_000,
    });

    await expect(createVoiceRealtimeTokenCommand()).resolves.toEqual({
      value: 'ek_abc',
      expiresAt: 1_700_000_000,
    });
    expect(mockCreateVoiceRealtimeClientSecret).toHaveBeenCalledWith('sk-test');
  });

  it('refuses when voice is not configured', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue(undefined);

    await expect(createVoiceRealtimeTokenCommand()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockCreateVoiceRealtimeClientSecret).not.toHaveBeenCalled();
  });

  it('maps upstream failures to BAD_GATEWAY without leaking details', async () => {
    mockResolveVoiceOpenAiKey.mockResolvedValue('sk-test');
    mockCreateVoiceRealtimeClientSecret.mockRejectedValue(
      new Error('status 500'),
    );

    const error = await createVoiceRealtimeTokenCommand().catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_GATEWAY');
    expect((error as TRPCError).message).toBe(
      'Failed to start a voice session',
    );
  });
});
