const { mockResolveTelegramRuntimeCredentials, mockTelegramProvider } =
  vi.hoisted(() => ({
    mockResolveTelegramRuntimeCredentials: vi.fn(),
    mockTelegramProvider: vi.fn(),
  }));

vi.mock('@roomote/db/server', () => ({
  resolveTelegramRuntimeCredentials: mockResolveTelegramRuntimeCredentials,
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
});
