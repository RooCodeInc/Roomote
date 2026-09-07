const {
  mockResolveTelegramRuntimeCredentials,
  mockResolveManaged,
  mockFindSession,
  mockTelegramProvider,
} = vi.hoisted(() => ({
  mockResolveTelegramRuntimeCredentials: vi.fn(),
  mockResolveManaged: vi.fn(),
  mockFindSession: vi.fn(),
  mockTelegramProvider: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveTelegramRuntimeCredentials: mockResolveTelegramRuntimeCredentials,
  resolveTelegramManagedBotCredentials: mockResolveManaged,
  db: { query: { fastAgentConversations: { findFirst: mockFindSession } } },
  eq: vi.fn(),
  fastAgentConversations: { id: 'id' },
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: mockTelegramProvider,
}));

import { createTelegramCommunicationProviderFromRuntimeCredentials } from '../telegram-communication';

describe('createTelegramCommunicationProviderFromRuntimeCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no bot token is configured', async () => {
    mockResolveTelegramRuntimeCredentials.mockResolvedValue({
      botToken: null,
      webhookSecret: null,
      botUsername: null,
    });

    await expect(
      createTelegramCommunicationProviderFromRuntimeCredentials(),
    ).resolves.toBeNull();
    expect(mockTelegramProvider).not.toHaveBeenCalled();
  });

  it('builds a provider from the resolved bot token', async () => {
    mockResolveTelegramRuntimeCredentials.mockResolvedValue({
      botToken: '123:abc',
      webhookSecret: null,
      botUsername: 'roomote_bot',
    });

    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();

    expect(provider).toBeInstanceOf(mockTelegramProvider);
    expect(mockTelegramProvider).toHaveBeenCalledWith({ botToken: '123:abc' });
  });

  it('passes a custom fetch through to the provider', async () => {
    mockResolveTelegramRuntimeCredentials.mockResolvedValue({
      botToken: '123:abc',
      webhookSecret: null,
      botUsername: null,
    });
    const customFetch = vi.fn();

    await createTelegramCommunicationProviderFromRuntimeCredentials({
      fetch: customFetch as unknown as typeof fetch,
    });

    expect(mockTelegramProvider).toHaveBeenCalledWith({
      botToken: '123:abc',
      fetch: customFetch,
    });
  });

  const binding = {
    botToken: '456:child',
    botId: '456',
    ownerTelegramUserId: '789',
    sessionId: 'session-1',
  };

  it('never falls back to global credentials for a missing, revoked, or malformed managed route', async () => {
    mockResolveManaged.mockResolvedValue(null);
    for (const workspaceId of ['telegram-bot:456', 'telegram-bot:invalid']) {
      expect(
        await createTelegramCommunicationProviderFromRuntimeCredentials({
          workspaceId,
        }),
      ).toBeNull();
    }
    expect(mockResolveTelegramRuntimeCredentials).not.toHaveBeenCalled();
    expect(mockTelegramProvider).not.toHaveBeenCalled();
  });

  it('rejects a binding belonging to another Session', async () => {
    mockResolveManaged.mockResolvedValue(binding);
    expect(
      await createTelegramCommunicationProviderFromRuntimeCredentials({
        workspaceId: 'telegram-bot:456',
        sessionId: 'other',
      }),
    ).toBeNull();
    expect(mockResolveTelegramRuntimeCredentials).not.toHaveBeenCalled();
  });

  it('uses the child token and rechecks owner and revocation before each request', async () => {
    mockResolveManaged.mockResolvedValue(binding);
    const transport = vi.fn().mockResolvedValue(new Response('{}'));
    await createTelegramCommunicationProviderFromRuntimeCredentials({
      workspaceId: 'telegram-bot:456',
      sessionId: binding.sessionId,
      fetch: transport,
    });
    const options = mockTelegramProvider.mock.calls[0]![0];
    expect(options.botToken).toBe('456:child');
    await options.fetch('https://api.telegram.org/bot456:child/sendMessage', {
      body: JSON.stringify({ chat_id: 789 }),
    });
    expect(transport).toHaveBeenCalledOnce();
    await expect(
      options.fetch('https://api.telegram.org/bot456:child/sendPhoto', {
        body: JSON.stringify({ chat_id: 999 }),
      }),
    ).rejects.toThrow('private owner chat');
    mockResolveManaged.mockResolvedValue(null);
    await expect(
      options.fetch('https://api.telegram.org/bot456:child/editMessageText', {
        body: JSON.stringify({ chat_id: 789 }),
      }),
    ).rejects.toThrow('disconnected');
    expect(transport).toHaveBeenCalledOnce();
    expect(mockResolveTelegramRuntimeCredentials).not.toHaveBeenCalled();
  });

  it('sanitizes child transport errors instead of exposing token-bearing URLs', async () => {
    mockResolveManaged.mockResolvedValue(binding);
    await createTelegramCommunicationProviderFromRuntimeCredentials({
      workspaceId: 'telegram-bot:456',
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error('https://api.telegram.org/bot456:child/sendMessage'),
        ),
    });
    const guardedFetch = mockTelegramProvider.mock.calls[0]![0].fetch;
    await expect(
      guardedFetch('https://api.telegram.org/bot456:child/sendMessage'),
    ).rejects.toThrow('Telegram session bot request failed.');
  });

  it('prevents an old main-bot adapter from sending after Session activation', async () => {
    mockResolveTelegramRuntimeCredentials.mockResolvedValue({
      botToken: '123:main',
    });
    mockFindSession.mockResolvedValue({
      surface: 'telegram',
      workspaceId: 'telegram-bot:456',
    });
    const transport = vi.fn();
    await createTelegramCommunicationProviderFromRuntimeCredentials({
      workspaceId: '789',
      sessionId: binding.sessionId,
      fetch: transport,
    });
    const guardedFetch = mockTelegramProvider.mock.calls[0]![0].fetch;
    await expect(
      guardedFetch('https://api.telegram.org/bot123:main/sendMessage'),
    ).rejects.toThrow('route changed');
    expect(transport).not.toHaveBeenCalled();
  });
});
