import { getTeamsIntegrationStatusCommand } from './index';

import type { UserAuthSuccess } from '@/types';

const {
  mockResolveTeamsBotRuntimeCredentials,
  mockFindTeamsPrimaryConversation,
  mockResolveAuthProviderConfig,
} = vi.hoisted(() => ({
  mockResolveTeamsBotRuntimeCredentials: vi.fn(),
  mockFindTeamsPrimaryConversation: vi.fn(),
  mockResolveAuthProviderConfig: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveTeamsBotRuntimeCredentials: mockResolveTeamsBotRuntimeCredentials,
  resolveTeamsInvocationBotName: vi.fn(async () => 'Roomote'),
}));

vi.mock('@roomote/sdk/server', () => ({
  findTeamsPrimaryConversation: mockFindTeamsPrimaryConversation,
}));

vi.mock('@/lib/server', () => ({
  Env: {
    R_PUBLIC_URL: 'https://roomote.example.com',
    R_APP_URL: 'https://app.example.com',
  },
}));

vi.mock('@/lib/server/auth-provider-config', () => ({
  resolveAuthProviderConfig: mockResolveAuthProviderConfig,
}));

const mockAuth = { userId: 'user-1' } as UserAuthSuccess;

function buildCredentials(
  overrides: Partial<{
    botAppId: string | null;
    botAppPassword: string | null;
    botTenantId: string | null;
    source: 'teams_bot' | null;
  }> = {},
) {
  return {
    botAppId: 'bot-app-id',
    botAppPassword: 'bot-app-password',
    botTenantId: null,
    botTokenEndpoint: null,
    botOauthScope: null,
    source: 'teams_bot' as const,
    ...overrides,
  };
}

describe('getTeamsIntegrationStatusCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTeamsBotRuntimeCredentials.mockResolvedValue(buildCredentials());
    mockFindTeamsPrimaryConversation.mockResolvedValue(null);
    mockResolveAuthProviderConfig.mockResolvedValue({
      microsoftClientId: 'client-id',
      microsoftClientSecret: 'client-secret',
      microsoftTenantId: 'tenant-id',
    });
  });

  it('reports a configured bot without a captured primary conversation', async () => {
    const status = await getTeamsIntegrationStatusCommand(mockAuth);

    expect(status.botConfigured).toBe(true);
    expect(status.microsoftAuthConfigured).toBe(true);
    expect(status.primaryConversationReady).toBe(false);
    expect(status.primaryConversationType).toBeNull();
    expect(status.webhookUrl).toBe(
      'https://roomote.example.com/api/webhooks/teams',
    );
    expect(status.openInTeamsUrl).toBe(
      'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot-app-id',
    );
    expect(status.botName).toBe('Roomote');
  });

  it('reports readiness when a primary Teams conversation was captured', async () => {
    mockFindTeamsPrimaryConversation.mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      conversationType: 'channel',
    });

    const status = await getTeamsIntegrationStatusCommand(mockAuth);

    expect(status.primaryConversationReady).toBe(true);
    expect(status.primaryConversationType).toBe('channel');
  });

  it('reports an unconfigured bot without inventing conversation readiness', async () => {
    mockResolveTeamsBotRuntimeCredentials.mockResolvedValue(
      buildCredentials({
        botAppId: null,
        botAppPassword: null,
        source: null,
      }),
    );

    const status = await getTeamsIntegrationStatusCommand(mockAuth);

    expect(status.botConfigured).toBe(false);
    expect(status.openInTeamsUrl).toBeNull();
    expect(status.primaryConversationReady).toBe(false);
    expect(status.primaryConversationType).toBeNull();
  });
});
