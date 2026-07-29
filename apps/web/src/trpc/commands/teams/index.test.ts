import { TeamsBotCredentialValidationError } from '@roomote/communication/teams-credential-validation';

import { getTeamsIntegrationStatusCommand } from './index';
import { invalidateTeamsBotCredentialCheckCache } from './bot-credential-check';

import type { UserAuthSuccess } from '@/types';

const {
  mockResolveTeamsBotRuntimeCredentials,
  mockFindTeamsPrimaryConversation,
  mockResolveAuthProviderConfig,
  mockValidateTeamsBotCredentials,
} = vi.hoisted(() => ({
  mockResolveTeamsBotRuntimeCredentials: vi.fn(),
  mockFindTeamsPrimaryConversation: vi.fn(),
  mockResolveAuthProviderConfig: vi.fn(),
  mockValidateTeamsBotCredentials: vi.fn(async () => undefined),
}));

vi.mock('@roomote/communication/teams-credential-validation', () => ({
  validateTeamsBotCredentials: mockValidateTeamsBotCredentials,
  TeamsBotCredentialValidationError: class TeamsBotCredentialValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly field: string | null = null,
      readonly detail: string | null = null,
    ) {
      super(message);
      this.name = 'TeamsBotCredentialValidationError';
    }
  },
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
    invalidateTeamsBotCredentialCheckCache();
    mockValidateTeamsBotCredentials.mockResolvedValue(undefined);
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
    expect(status.botCredentialCheck).toEqual({ status: 'ok', message: null });
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
    expect(status.botCredentialCheck).toEqual({
      status: 'unchecked',
      message: null,
    });
    expect(status.openInTeamsUrl).toBeNull();
    expect(status.primaryConversationReady).toBe(false);
    expect(status.primaryConversationType).toBeNull();
    expect(mockValidateTeamsBotCredentials).not.toHaveBeenCalled();
  });

  it('reports credentials that never authenticated as failed, not configured', async () => {
    mockValidateTeamsBotCredentials.mockRejectedValue(
      new TeamsBotCredentialValidationError(
        'invalid_app_id',
        'Microsoft rejected the app (client) id.',
        'app_id',
        "AADSTS700016: Application with identifier 'bot-app-id' was not found in the directory.",
      ),
    );

    const status = await getTeamsIntegrationStatusCommand(mockAuth);

    expect(status.botConfigured).toBe(true);
    expect(status.botCredentialCheck.status).toBe('failed');
    expect(status.botCredentialCheck.message).toContain(
      'Teams Bot App ID (R_TEAMS_BOT_APP_ID)',
    );
    expect(status.botCredentialCheck.message).toContain('AADSTS700016');
  });

  it('treats an unreachable Microsoft as unchecked, not as a credential failure', async () => {
    mockValidateTeamsBotCredentials.mockRejectedValue(
      new TeamsBotCredentialValidationError(
        'unreachable',
        'Could not reach Microsoft to verify the Teams bot credentials (timed out).',
        null,
        'The operation timed out.',
      ),
    );

    const status = await getTeamsIntegrationStatusCommand(mockAuth);

    expect(status.botCredentialCheck.status).toBe('unchecked');
    expect(status.botCredentialCheck.message).toContain(
      'login.microsoftonline.com',
    );
  });

  it('caches the credential verdict so status polling does not hammer Microsoft', async () => {
    await getTeamsIntegrationStatusCommand(mockAuth);
    await getTeamsIntegrationStatusCommand(mockAuth);

    expect(mockValidateTeamsBotCredentials).toHaveBeenCalledTimes(1);
  });

  it('re-checks when only the client secret changed', async () => {
    await getTeamsIntegrationStatusCommand(mockAuth);
    mockResolveTeamsBotRuntimeCredentials.mockResolvedValue(
      buildCredentials({ botAppPassword: 'rotated-app-password' }),
    );

    await getTeamsIntegrationStatusCommand(mockAuth);

    expect(mockValidateTeamsBotCredentials).toHaveBeenCalledTimes(2);
  });
});
