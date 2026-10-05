const {
  bootstrapWebRuntimeEnvMock,
  isEmailChannelEnabledMock,
  redisEvalMock,
  canSendAgentMailWithRuntimeCredentialsMock,
} = vi.hoisted(() => ({
  bootstrapWebRuntimeEnvMock: vi.fn(),
  isEmailChannelEnabledMock: vi.fn(),
  redisEvalMock: vi.fn(),
  canSendAgentMailWithRuntimeCredentialsMock: vi.fn(),
}));

vi.mock('./bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));
vi.mock('./env', () => ({
  isEmailChannelEnabled: isEmailChannelEnabledMock,
}));
vi.mock('@roomote/db/server', () => ({
  canSendAgentMailWithRuntimeCredentials:
    canSendAgentMailWithRuntimeCredentialsMock,
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: redisEvalMock }),
}));

import {
  isSelfServicePasswordResetAllowed,
  isSelfServicePasswordResetAvailable,
} from './self-service-password-reset';

describe('self-service password reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapWebRuntimeEnvMock.mockResolvedValue(undefined);
    isEmailChannelEnabledMock.mockReturnValue(true);
    canSendAgentMailWithRuntimeCredentialsMock.mockResolvedValue(true);
    redisEvalMock.mockResolvedValue(1);
  });

  it('requires the email channel to be enabled', async () => {
    isEmailChannelEnabledMock.mockReturnValue(false);

    await expect(isSelfServicePasswordResetAvailable()).resolves.toBe(false);
    expect(canSendAgentMailWithRuntimeCredentialsMock).not.toHaveBeenCalled();
  });

  it('requires AgentMail delivery (configured, or allocated by Cloud on send)', async () => {
    canSendAgentMailWithRuntimeCredentialsMock.mockResolvedValue(false);

    await expect(isSelfServicePasswordResetAvailable()).resolves.toBe(false);
  });

  it('reports availability when the channel can deliver', async () => {
    await expect(isSelfServicePasswordResetAvailable()).resolves.toBe(true);
  });

  it('allows requests below the email, client, and global limits', async () => {
    await expect(
      isSelfServicePasswordResetAllowed({
        email: 'ada@example.com',
        clientAddress: '203.0.113.10',
      }),
    ).resolves.toBe(true);
    expect(redisEvalMock).toHaveBeenCalledTimes(3);
    expect(redisEvalMock.mock.calls.flat().join(' ')).not.toContain(
      'ada@example.com',
    );
    expect(redisEvalMock.mock.calls.flat().join(' ')).not.toContain(
      '203.0.113.10',
    );
  });

  it('silently rejects requests above any abuse limit', async () => {
    redisEvalMock
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    await expect(
      isSelfServicePasswordResetAllowed({
        email: 'ada@example.com',
        clientAddress: '203.0.113.10',
      }),
    ).resolves.toBe(false);
  });

  it('applies the shared client limit when no trusted address is available', async () => {
    redisEvalMock
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(21);

    await expect(
      isSelfServicePasswordResetAllowed({
        email: 'ada@example.com',
        clientAddress: null,
      }),
    ).resolves.toBe(false);
    expect(redisEvalMock).toHaveBeenCalledTimes(3);
    expect(redisEvalMock.mock.calls[2]?.[2]).toMatch(
      /^password-reset:client:/u,
    );
  });
});
