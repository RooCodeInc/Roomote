const {
  bootstrapWebRuntimeEnvMock,
  isEmailChannelEnabledMock,
  redisEvalMock,
  resolveAgentMailRuntimeCredentialsMock,
} = vi.hoisted(() => ({
  bootstrapWebRuntimeEnvMock: vi.fn(),
  isEmailChannelEnabledMock: vi.fn(),
  redisEvalMock: vi.fn(),
  resolveAgentMailRuntimeCredentialsMock: vi.fn(),
}));

vi.mock('./bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));
vi.mock('./env', () => ({
  isEmailChannelEnabled: isEmailChannelEnabledMock,
}));
vi.mock('@roomote/db/server', () => ({
  resolveAgentMailRuntimeCredentials: resolveAgentMailRuntimeCredentialsMock,
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
    resolveAgentMailRuntimeCredentialsMock.mockResolvedValue({
      apiKey: 'agentmail-key',
      inboxId: 'roomote@example.agentmail.to',
      webhookSecret: null,
    });
    redisEvalMock.mockResolvedValue(1);
  });

  it('requires the email channel to be enabled', async () => {
    isEmailChannelEnabledMock.mockReturnValue(false);

    await expect(isSelfServicePasswordResetAvailable()).resolves.toBe(false);
    expect(resolveAgentMailRuntimeCredentialsMock).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: null, inboxId: 'roomote@example.agentmail.to' },
    { apiKey: 'agentmail-key', inboxId: null },
  ])(
    'requires configured AgentMail delivery credentials',
    async (credentials) => {
      resolveAgentMailRuntimeCredentialsMock.mockResolvedValue({
        ...credentials,
        webhookSecret: null,
      });

      await expect(isSelfServicePasswordResetAvailable()).resolves.toBe(false);
    },
  );

  it('reports availability with the channel, API key, and inbox configured', async () => {
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
