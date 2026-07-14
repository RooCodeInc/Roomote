const {
  mockFindFirstSlackInstallation,
  mockSlackNotifier,
  mockSlackCommunicationProvider,
  mockCreateTeamsProvider,
  mockCreateTelegramProvider,
} = vi.hoisted(() => ({
  mockFindFirstSlackInstallation: vi.fn(),
  mockSlackNotifier: vi.fn(),
  mockSlackCommunicationProvider: vi.fn(),
  mockCreateTeamsProvider: vi.fn(),
  mockCreateTelegramProvider: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findFirst: mockFindFirstSlackInstallation },
    },
  },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  slackInstallations: { isActive: 'isActive' },
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: mockSlackNotifier,
  SlackCommunicationProvider: mockSlackCommunicationProvider,
}));

vi.mock('../teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    mockCreateTeamsProvider,
}));

vi.mock('../telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    mockCreateTelegramProvider,
}));

import { getCommunicationProviderAdapter } from '../communication-providers';

describe('getCommunicationProviderAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a Slack adapter from the active installation', async () => {
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    });

    const adapter = await getCommunicationProviderAdapter('slack');

    expect(adapter).toBeInstanceOf(mockSlackCommunicationProvider);
    expect(mockSlackNotifier).toHaveBeenCalledWith('xoxb-token');
  });

  it('returns null for Slack when no installation is active', async () => {
    mockFindFirstSlackInstallation.mockResolvedValue(undefined);

    await expect(getCommunicationProviderAdapter('slack')).resolves.toBeNull();
    expect(mockSlackCommunicationProvider).not.toHaveBeenCalled();
  });

  it('dispatches Teams to the shared Teams factory', async () => {
    const teamsAdapter = { provider: 'teams' };
    mockCreateTeamsProvider.mockResolvedValue(teamsAdapter);

    await expect(getCommunicationProviderAdapter('teams')).resolves.toBe(
      teamsAdapter,
    );
  });

  it('dispatches Telegram to the shared Telegram factory', async () => {
    mockCreateTelegramProvider.mockResolvedValue(null);

    await expect(
      getCommunicationProviderAdapter('telegram'),
    ).resolves.toBeNull();
    expect(mockCreateTelegramProvider).toHaveBeenCalled();
  });
});
