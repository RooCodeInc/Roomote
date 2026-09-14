const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  registerCommands: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    mocks.createProvider,
}));

import { refreshTelegramCommandMenuAtBoot } from '../command-registration.js';

describe('refreshTelegramCommandMenuAtBoot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createProvider.mockResolvedValue({
      registerCommands: mocks.registerCommands,
    });
    mocks.registerCommands.mockResolvedValue(undefined);
  });

  it('refreshes the configured runtime bot command menu', async () => {
    await refreshTelegramCommandMenuAtBoot();

    expect(mocks.registerCommands).toHaveBeenCalledOnce();
  });

  it('is a no-op when Telegram credentials are unavailable', async () => {
    mocks.createProvider.mockResolvedValue(null);

    await refreshTelegramCommandMenuAtBoot();

    expect(mocks.registerCommands).not.toHaveBeenCalled();
  });
});
