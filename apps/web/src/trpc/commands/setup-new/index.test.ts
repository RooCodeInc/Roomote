import type { UserAuthSuccess } from '@/types';

const {
  mockTxSelect,
  mockDbTransaction,
  mockUpsertDeploymentEnvironmentVariables,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
  mockValidateTeamsBotCredentials,
  mockGetSetupBootstrapState,
  mockSetupTokenState,
  mockRunComputeProvisioning,
  mockAcquireComputeProvisioningLock,
  mockResolveSavedWorkerImage,
  mockResolveGiteaBaseUrl,
  mockResolveDeploymentEnvVar,
  mockRecordSetupFunnelMilestones,
  mockGetLinkedTelegramAccount,
  mockGetLinkedDiscordAccount,
  mockGetTeamsIntegrationStatus,
} = vi.hoisted(() => ({
  mockValidateTeamsBotCredentials: vi.fn(async () => undefined),
  mockTxSelect: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn().mockResolvedValue([]),
  mockGetPersistedEnvironmentVariableValues: vi.fn().mockResolvedValue({}),
  mockGetSetupBootstrapState: vi.fn(),
  mockSetupTokenState: {
    requiredToken: undefined as string | undefined,
    inviteCookieToken: null as string | null,
  },
  mockRunComputeProvisioning: vi.fn().mockResolvedValue(undefined),
  mockAcquireComputeProvisioningLock: vi.fn().mockResolvedValue(undefined),
  mockResolveSavedWorkerImage: vi.fn().mockResolvedValue(null),
  mockResolveGiteaBaseUrl: vi
    .fn()
    .mockResolvedValue('https://gitea.example.com'),
  mockResolveDeploymentEnvVar: vi.fn().mockResolvedValue(null),
  mockRecordSetupFunnelMilestones: vi.fn().mockResolvedValue(undefined),
  mockGetLinkedTelegramAccount: vi.fn(),
  mockGetLinkedDiscordAccount: vi.fn(),
  mockGetTeamsIntegrationStatus: vi.fn(),
}));

vi.mock('@/lib/server/setup-funnel-telemetry', () => ({
  evaluateSetupFunnelMilestones: vi.fn(() => []),
  recordSetupFunnelMilestones: mockRecordSetupFunnelMilestones,
}));

vi.mock('../linked-accounts', () => ({
  getLinkedTelegramAccountCommand: mockGetLinkedTelegramAccount,
  getLinkedDiscordAccountCommand: mockGetLinkedDiscordAccount,
}));

vi.mock('../teams', () => ({
  getTeamsIntegrationStatusCommand: mockGetTeamsIntegrationStatus,
}));

vi.mock('../compute/compute-provisioning', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../compute/compute-provisioning')>();

  return {
    ...actual,
    acquireComputeProvisioningLock: mockAcquireComputeProvisioningLock,
    runComputeProvisioning: mockRunComputeProvisioning,
  };
});

vi.mock('@roomote/github', () => ({
  getRepositoryEmptyStates: vi.fn(async () => new Map()),
}));

vi.mock('@roomote/gitea', () => ({
  normalizeGiteaBaseUrl: (value: string) =>
    value.startsWith('http') ? value : `https://${value}`,
  resolveGiteaBaseUrl: mockResolveGiteaBaseUrl,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn(),
}));

vi.mock('@roomote/communication/discord-provider', () => ({
  DiscordCommunicationProvider: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(
    async () => null,
  ),
  findTelegramPrimaryChatId: vi.fn(async () => null),
  findDiscordDefaultDestination: vi.fn(async () => null),
  findDiscordUserMappingByRoomoteUserId: vi.fn(async () => null),
  findTeamsPrimaryConversation: vi.fn(async () => null),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  taskRuns: {},
  db: {
    select: mockTxSelect,
    transaction: mockDbTransaction,
  },
  deploymentSettings: {
    id: 'deployment_settings.id',
    setupNewState: 'deployment_settings.setup_new_state',
    runtimeModelConfig: 'deployment_settings.runtime_model_config',
  },
  environmentVariables: {
    name: 'environment_variables.name',
  },
  environments: {},
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  markTaskStartParallelCountEndedAt: vi.fn(),
  resolveSavedWorkerImage: mockResolveSavedWorkerImage,
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
  purgeSavedDeploymentWorkerImage: vi.fn(async () => undefined),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: null,
    webhookSecret: null,
    botUsername: null,
  })),
  resolveDiscordRuntimeCredentials: vi.fn(async () => ({
    botToken: null,
    applicationId: null,
    applicationName: null,
    botUserId: null,
    botUsername: null,
    botDisplayName: null,
    identitySource: null,
    identityErrorCode: null,
  })),
  invalidateTeamsBotRuntimeCredentialsCache: vi.fn(),
  slackInstallations: {},
  slackUserMappings: {},
  sql: vi.fn(),
  users: {},
  workItems: {},
  isChatGptSubscriptionConnected: vi.fn(async () => false),
  isGitHubCopilotSubscriptionConnected: vi.fn(async () => false),
  isXaiSubscriptionConnected: vi.fn(async () => false),
}));

vi.mock('@/lib/server', () => ({
  getLatestTaskRunsByTaskId: vi.fn(),
  getRepositories: vi.fn(),
  getRequestInviteToken: vi.fn(
    async () => mockSetupTokenState.inviteCookieToken,
  ),
  isSetupTokenRequired: () => mockSetupTokenState.requiredToken != null,
  isSetupTokenValid: (setupToken: string | undefined) =>
    mockSetupTokenState.requiredToken == null ||
    setupToken === mockSetupTokenState.requiredToken,
  assertSetupTokenValid: (setupToken: string | undefined) => {
    if (
      mockSetupTokenState.requiredToken != null &&
      setupToken !== mockSetupTokenState.requiredToken
    ) {
      throw new Error('A valid setup token is required.');
    }
  },
}));

vi.mock('@/lib/repositories', () => ({
  areAllRepositoriesEmpty: vi.fn(),
}));

vi.mock('@/lib/setup-new', () => ({
  appendEnvironmentDefinitionGuidance: vi.fn(),
  buildSetupEnvironmentTaskTitle: vi.fn((repositoryFullNames: string[]) => {
    const repositoryNames = repositoryFullNames
      .map((fullName) => fullName.split('/').at(-1)?.trim() || fullName.trim())
      .filter(Boolean);

    return repositoryNames.length === 0
      ? 'Set up your first environment'
      : `Set up the ${repositoryNames.join(' + ')} environment`;
  }),
  buildSetupNewKickoffPrompt: vi.fn(),
  buildSetupNewWorkspacePayload: vi.fn(),
  findMatchingSetupNewEnvironment: vi.fn(),
  isSetupNewOnboardingFailureStatus: vi.fn(),
  isSetupNewOnboardingSuccessStatus: vi.fn(),
  isSetupNewOnboardingTerminalSuccessStatus: vi.fn(),
  normalizeRepositorySelection: vi.fn(),
}));

vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
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

vi.mock('../task-suggestions', () => ({
  triggerTaskSuggestionsCommand: vi.fn(),
}));

vi.mock('../setup/shared', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) {
      throw new Error('Unauthorized');
    }
  },
  ensureDefaultSetupAgents: vi.fn(),
  getSetupBaseStatus: vi.fn(),
  getSetupBootstrapState: mockGetSetupBootstrapState,
}));

import {
  getSetupBootstrapStatusCommand,
  saveSetupBootstrapAuthConfigCommand,
  saveSetupBootstrapAuthProviderChoiceCommand,
  saveSetupNewAuthConfigCommand,
  saveSetupNewComputeConfigCommand,
  saveSetupNewComputeProviderChoiceCommand,
  saveSetupNewSourceControlConfigCommand,
  saveSetupNewSourceControlProviderChoiceCommand,
  startSetupNewOnboardingTaskCommand,
  trackSetupBootstrapWelcomeSeenCommand,
  trackSetupCommsStateCommand,
  trackSetupWelcomeSeenCommand,
} from './index';
import {
  TaskPayloadKind,
  WORKER_RUNTIME_SCHEMA_VERSION,
  type SetupNewState,
} from '@roomote/types';
import { enqueueTask } from '@roomote/cloud-agents/server';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import {
  invalidateTeamsBotRuntimeCredentialsCache,
  resolveDiscordRuntimeCredentials,
  resolveTelegramRuntimeCredentials,
} from '@roomote/db/server';
import { TeamsBotCredentialValidationError } from '@roomote/communication/teams-credential-validation';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  findTelegramPrimaryChatId,
  findDiscordDefaultDestination,
  findDiscordUserMappingByRoomoteUserId,
  findTeamsPrimaryConversation,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';
import { getRepositories } from '@/lib/server';
import {
  appendEnvironmentDefinitionGuidance,
  buildSetupEnvironmentTaskTitle,
  buildSetupNewKickoffPrompt,
  buildSetupNewWorkspacePayload,
  normalizeRepositorySelection,
} from '@/lib/setup-new';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'setup-test-user',
    isAdmin: true,
    name: 'Setup Tester',
    primaryEmail: 'setup@example.com',
    resource: {
      username: 'setup-tester',
      fullName: 'Setup Tester',
      firstName: 'Setup',
      lastName: 'Tester',
      primaryEmailAddress: { id: '1', emailAddress: 'setup@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'setup@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

function createSelectChain(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => result),
      })),
    })),
  };
}

function createFromOnlySelectChain(result: unknown) {
  return {
    from: vi.fn(async () => result),
  };
}

describe('setup-new auth config commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelect.mockReset();
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockValidateTeamsBotCredentials.mockResolvedValue(undefined);
    process.env.E2B_TEMPLATE_ID = '';
    process.env.DAYTONA_SNAPSHOT_NAME = '';
    process.env.BLAXEL_IMAGE = '';

    mockDbTransaction.mockImplementation(async (callback) => {
      const tx = {
        select: mockTxSelect,
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(async () => undefined),
          })),
        })),
      };

      mockTxSelect
        .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
        .mockReturnValueOnce(createFromOnlySelectChain([]));

      return callback(tx);
    });
  });

  it('lets signed-in admins save auth config after bootstrap closes', async () => {
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: false });

    const result = await saveSetupNewAuthConfigCommand(buildMockAuth(), {
      provider: 'slack',
      values: {
        R_SLACK_CLIENT_ID: 'client-id',
        R_SLACK_CLIENT_SECRET: 'client-secret',
        R_SLACK_SIGNING_SECRET: 'signing-secret',
      },
    });

    expect(result.setupNewState.authProvider).toBe('slack');
    expect(mockGetSetupBootstrapState).not.toHaveBeenCalled();
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: expect.arrayContaining([
          expect.objectContaining({ name: 'R_SLACK_CLIENT_ID' }),
          expect.objectContaining({ name: 'R_SLACK_CLIENT_SECRET' }),
          expect.objectContaining({ name: 'R_SLACK_SIGNING_SECRET' }),
        ]),
      }),
    );
  });

  it('verifies Teams bot credentials and drops both caches after the commit', async () => {
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: false });

    await saveSetupNewAuthConfigCommand(buildMockAuth(), {
      provider: 'microsoft',
      values: {
        R_MICROSOFT_CLIENT_ID: 'ms-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
        R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
      },
    });

    expect(mockValidateTeamsBotCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'ms-client-id',
        appPassword: 'ms-client-secret',
        tenantId: 'ms-tenant-id',
      }),
    );
    // A stale 30s runtime cache would make the next status refresh report the
    // credentials that were replaced, not the ones just verified.
    expect(invalidateTeamsBotRuntimeCredentialsCache).toHaveBeenCalled();
  });

  it('does not save Teams credentials Microsoft rejects', async () => {
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: false });
    mockValidateTeamsBotCredentials.mockRejectedValue(
      new TeamsBotCredentialValidationError(
        'invalid_app_password',
        'Microsoft rejected the client secret.',
        'app_password',
        'AADSTS7000215: Invalid client secret provided.',
      ),
    );

    await expect(
      saveSetupNewAuthConfigCommand(buildMockAuth(), {
        provider: 'microsoft',
        values: {
          R_MICROSOFT_CLIENT_ID: 'ms-client-id',
          R_MICROSOFT_CLIENT_SECRET: 'wrong-secret',
          R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
        },
      }),
    ).rejects.toThrow(/AADSTS7000215/u);

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    expect(invalidateTeamsBotRuntimeCredentialsCache).not.toHaveBeenCalled();
  });

  it('records bootstrap auth config without manufacturing a user', async () => {
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: true });

    await saveSetupBootstrapAuthConfigCommand({
      provider: 'slack',
      values: {
        R_SLACK_CLIENT_ID: 'client-id',
        R_SLACK_CLIENT_SECRET: 'client-secret',
        R_SLACK_SIGNING_SECRET: 'signing-secret',
      },
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: null }),
    );
  });

  it('still blocks anonymous bootstrap saves once bootstrap closes', async () => {
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: false });

    await expect(
      saveSetupBootstrapAuthConfigCommand({
        provider: 'slack',
        values: {
          R_SLACK_CLIENT_ID: 'client-id',
          R_SLACK_CLIENT_SECRET: 'client-secret',
          R_SLACK_SIGNING_SECRET: 'signing-secret',
        },
      }),
    ).rejects.toThrow('Initial setup is no longer open.');

    expect(mockGetSetupBootstrapState).toHaveBeenCalledTimes(1);
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });
});

describe('setup funnel milestone commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetupTokenState.requiredToken = undefined;
    mockSetupTokenState.inviteCookieToken = null;
    mockGetLinkedTelegramAccount.mockResolvedValue({
      configured: false,
      mapping: null,
    });
    mockGetLinkedDiscordAccount.mockResolvedValue({
      configured: false,
      mapping: null,
    });
  });

  it('records welcome after an admin reaches signed-in setup', async () => {
    await trackSetupWelcomeSeenCommand(buildMockAuth());

    expect(mockRecordSetupFunnelMilestones).toHaveBeenCalledWith([
      { milestone: 'welcome' },
    ]);
  });

  it('requires a valid bootstrap token before recording welcome', async () => {
    mockSetupTokenState.requiredToken = 'expected-token';

    await expect(
      trackSetupBootstrapWelcomeSeenCommand({ setupToken: 'wrong-token' }),
    ).rejects.toThrow('A valid setup token is required.');
    expect(mockRecordSetupFunnelMilestones).not.toHaveBeenCalled();
  });

  it('derives communications milestones from authoritative account state', async () => {
    mockGetLinkedTelegramAccount.mockResolvedValue({
      configured: true,
      mapping: { telegramUserId: '42' },
    });

    await trackSetupCommsStateCommand(buildMockAuth(), {
      provider: 'telegram',
    });

    expect(mockRecordSetupFunnelMilestones).toHaveBeenCalledWith([
      {
        milestone: 'comms_configured',
        provider: 'telegram',
      },
      {
        milestone: 'comms_authed',
        provider: 'telegram',
      },
    ]);
  });
});

describe('setup bootstrap token gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelect.mockReset();
    mockSetupTokenState.requiredToken = 'expected-setup-token';
    mockSetupTokenState.inviteCookieToken = null;
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: true });

    mockDbTransaction.mockImplementation(async (callback) => {
      const tx = {
        select: mockTxSelect,
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(async () => undefined),
          })),
        })),
      };

      mockTxSelect
        .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
        .mockReturnValueOnce(createFromOnlySelectChain([]));

      return callback(tx);
    });
  });

  afterEach(() => {
    mockSetupTokenState.requiredToken = undefined;
    mockSetupTokenState.inviteCookieToken = null;
  });

  it('redacts bootstrap status without a valid setup token', async () => {
    const status = await getSetupBootstrapStatusCommand({
      setupToken: 'wrong-token',
    });

    expect(status).toEqual({
      setupOpen: true,
      setupTokenRequired: true,
      setupTokenSatisfied: false,
      authSetup: null,
    });
  });

  it('satisfies bootstrap status from the invite cookie when no explicit token is provided', async () => {
    // OAuth sign-in round-trips drop the ?token= query param, so the invite
    // cookie has to keep satisfying the gate.
    mockSetupTokenState.inviteCookieToken = 'expected-setup-token';

    mockTxSelect.mockReset();
    mockTxSelect.mockReturnValueOnce(
      createSelectChain([{ setupNewState: {} }]),
    );

    const status = await getSetupBootstrapStatusCommand();

    expect(status.setupTokenRequired).toBe(true);
    expect(status.setupTokenSatisfied).toBe(true);
  });

  it('redacts bootstrap status when the invite cookie holds the wrong token', async () => {
    mockSetupTokenState.inviteCookieToken = 'wrong-token';

    const status = await getSetupBootstrapStatusCommand();

    expect(status).toEqual({
      setupOpen: true,
      setupTokenRequired: true,
      setupTokenSatisfied: false,
      authSetup: null,
    });
  });

  it('blocks bootstrap auth config saves without a valid setup token', async () => {
    await expect(
      saveSetupBootstrapAuthConfigCommand({
        provider: 'slack',
        values: {
          R_SLACK_CLIENT_ID: 'client-id',
          R_SLACK_CLIENT_SECRET: 'client-secret',
          R_SLACK_SIGNING_SECRET: 'signing-secret',
        },
        setupToken: 'wrong-token',
      }),
    ).rejects.toThrow('A valid setup token is required.');

    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('blocks bootstrap provider choice saves without a setup token', async () => {
    await expect(
      saveSetupBootstrapAuthProviderChoiceCommand({
        provider: 'slack',
      }),
    ).rejects.toThrow('A valid setup token is required.');

    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('allows bootstrap provider choice saves with the correct setup token', async () => {
    const result = await saveSetupBootstrapAuthProviderChoiceCommand({
      provider: 'slack',
      setupToken: 'expected-setup-token',
    });

    expect(result.setupNewState.authProvider).toBe('slack');
  });

  it('allows bootstrap saves using the invite cookie token when no explicit token is provided', async () => {
    mockSetupTokenState.inviteCookieToken = 'expected-setup-token';

    const result = await saveSetupBootstrapAuthProviderChoiceCommand({
      provider: 'slack',
    });

    expect(result.setupNewState.authProvider).toBe('slack');
  });

  it('keeps bootstrap commands open when no setup token is configured', async () => {
    mockSetupTokenState.requiredToken = undefined;

    mockTxSelect.mockReset();
    mockTxSelect
      .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
      .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]));

    const status = await getSetupBootstrapStatusCommand();

    expect(status.setupTokenRequired).toBe(false);
    expect(status.setupTokenSatisfied).toBe(true);

    const result = await saveSetupBootstrapAuthProviderChoiceCommand({
      provider: 'slack',
    });

    expect(result.setupNewState.authProvider).toBe('slack');
  });
});

describe('setup-new source-control config commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGiteaBaseUrl.mockResolvedValue('https://gitea.example.com');
    mockResolveDeploymentEnvVar.mockResolvedValue(null);

    mockDbTransaction.mockImplementation(async (callback) => {
      const tx = {
        select: mockTxSelect,
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(async () => undefined),
          })),
        })),
      };

      mockTxSelect
        .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
        .mockReturnValueOnce(createFromOnlySelectChain([]));

      return callback(tx);
    });
  });

  it('persists the selected source-control provider choice', async () => {
    mockTxSelect.mockReset();
    mockTxSelect.mockReturnValueOnce(
      createSelectChain([{ setupNewState: {} }]),
    );

    const result = await saveSetupNewSourceControlProviderChoiceCommand(
      buildMockAuth(),
      {
        provider: 'gitlab',
      },
    );

    expect(result.setupNewState.sourceControlProvider).toBe('gitlab');
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('saves source-control config into encrypted deployment env vars', async () => {
    const result = await saveSetupNewSourceControlConfigCommand(
      buildMockAuth(),
      {
        provider: 'gitea',
        values: {
          GITEA_BASE_URL: 'gitea.example.com',
          GITEA_CLIENT_ID: 'gitea-client-id',
          GITEA_CLIENT_SECRET: 'gitea-client-secret',
        },
      },
    );

    expect(result.setupNewState.sourceControlProvider).toBe('gitea');
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: expect.arrayContaining([
          expect.objectContaining({
            name: 'GITEA_BASE_URL',
            value: 'https://gitea.example.com',
          }),
          expect.objectContaining({ name: 'GITEA_CLIENT_ID' }),
          expect.objectContaining({ name: 'GITEA_CLIENT_SECRET' }),
        ]),
      }),
    );
  });

  it('preserves existing saved values when fields are left blank', async () => {
    mockTxSelect.mockReset();
    mockTxSelect
      .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
      .mockReturnValueOnce(
        createFromOnlySelectChain([
          { name: 'GITEA_CLIENT_ID' },
          { name: 'GITEA_CLIENT_SECRET' },
        ]),
      );
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'GITEA_CLIENT_ID' || name === 'GITEA_CLIENT_SECRET'
        ? 'saved-value'
        : null,
    );

    await saveSetupNewSourceControlConfigCommand(buildMockAuth(), {
      provider: 'gitea',
      values: {
        GITEA_BASE_URL: 'https://gitea.example.com',
      },
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        values: [expect.objectContaining({ name: 'GITEA_BASE_URL' })],
      }),
    );
  });

  it('rejects missing required fields', async () => {
    await expect(
      saveSetupNewSourceControlConfigCommand(buildMockAuth(), {
        provider: 'gitea',
        values: {
          GITEA_BASE_URL: 'https://gitea.example.com',
        },
      }),
    ).rejects.toThrow(
      'Configure the Gitea OAuth client ID and secret to continue.',
    );

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });
});

describe('setup-new compute config commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelect.mockReset();
    mockResolveSavedWorkerImage.mockResolvedValue(null);
    // These can leak in from the sandbox environment and would otherwise lock
    // the credential fields (runtime env values are not overwritten).
    vi.stubEnv('MODAL_TOKEN_ID', '');
    vi.stubEnv('MODAL_TOKEN_SECRET', '');
    vi.stubEnv('E2B_API_KEY', '');
    vi.stubEnv('DAYTONA_API_KEY', '');

    mockDbTransaction.mockImplementation(async (callback) => {
      const tx = {
        select: mockTxSelect,
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(async () => undefined),
          })),
        })),
      };

      mockTxSelect
        .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
        .mockReturnValueOnce(
          createSelectChain([{ runtimeComputeConfig: null }]),
        );

      return callback(tx);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.E2B_TEMPLATE_ID;
    delete process.env.DAYTONA_SNAPSHOT_NAME;
    delete process.env.BLAXEL_IMAGE;
  });

  it('commits Local Docker as the runtime default when it is chosen', async () => {
    const result = await saveSetupNewComputeProviderChoiceCommand(
      buildMockAuth(),
      {
        provider: 'docker',
      },
    );

    expect(result.setupNewState.computeProvider).toBe('docker');
    expect(result.runtimeComputeConfig.defaultProvider).toBe('docker');
  });

  it('rejects an excluded provider choice', async () => {
    vi.stubEnv('EXCLUDED_COMPUTE_PROVIDERS', 'docker');

    await expect(
      saveSetupNewComputeProviderChoiceCommand(buildMockAuth(), {
        provider: 'docker',
      }),
    ).rejects.toThrow('Selected sandbox provider is unavailable.');
  });

  it('rejects configuration for an excluded provider', async () => {
    vi.stubEnv('EXCLUDED_COMPUTE_PROVIDERS', 'modal');

    await expect(
      saveSetupNewComputeConfigCommand(buildMockAuth(), {
        provider: 'modal',
        values: {
          MODAL_TOKEN_ID: 'token-id',
          MODAL_TOKEN_SECRET: 'token-secret',
        },
      }),
    ).rejects.toThrow('Selected sandbox provider is unavailable.');

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('persists a Modal base image derived from the worker image', async () => {
    vi.stubEnv(
      'DOCKER_WORKER_IMAGE',
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
    vi.stubEnv('MODAL_BASE_IMAGE_REF', '');

    const result = await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'modal',
      values: {
        MODAL_TOKEN_ID: 'token-id',
        MODAL_TOKEN_SECRET: 'token-secret',
      },
    });

    expect(result.runtimeComputeConfig.defaultProvider).toBe('modal');
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: expect.arrayContaining([
          expect.objectContaining({ name: 'MODAL_TOKEN_ID' }),
          expect.objectContaining({ name: 'MODAL_TOKEN_SECRET' }),
          expect.objectContaining({
            name: 'MODAL_BASE_IMAGE_REF',
            value: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
          }),
        ]),
      }),
    );
  });

  it('persists a Modal base image derived from RELEASE_VERSION when no worker image is set', async () => {
    vi.stubEnv('RELEASE_VERSION', 'v1.2.3');
    vi.stubEnv('MODAL_BASE_IMAGE_REF', '');

    const result = await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'modal',
      values: {
        MODAL_TOKEN_ID: 'token-id',
        MODAL_TOKEN_SECRET: 'token-secret',
      },
    });

    expect(result.runtimeComputeConfig.defaultProvider).toBe('modal');
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: expect.arrayContaining([
          expect.objectContaining({
            name: 'MODAL_BASE_IMAGE_REF',
            value: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
          }),
        ]),
      }),
    );
  });

  it('rejects Modal when no base image default can be derived', async () => {
    vi.stubEnv('DOCKER_WORKER_IMAGE', 'roomote-worker:local');
    vi.stubEnv('MODAL_BASE_IMAGE_REF', '');

    await expect(
      saveSetupNewComputeConfigCommand(buildMockAuth(), {
        provider: 'modal',
        values: {
          MODAL_TOKEN_ID: 'token-id',
          MODAL_TOKEN_SECRET: 'token-secret',
        },
      }),
    ).rejects.toThrow(
      'Enter the required Modal configuration values to continue.',
    );

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('ignores a form-submitted MODAL_BASE_IMAGE_REF when no derivable image exists', async () => {
    vi.stubEnv('DOCKER_WORKER_IMAGE', 'roomote-worker:local');
    vi.stubEnv('MODAL_BASE_IMAGE_REF', '');

    await expect(
      saveSetupNewComputeConfigCommand(buildMockAuth(), {
        provider: 'modal',
        values: {
          MODAL_TOKEN_ID: 'token-id',
          MODAL_TOKEN_SECRET: 'token-secret',
          MODAL_BASE_IMAGE_REF: 'registry.example.com/fake-manual:tag',
        },
      }),
    ).rejects.toThrow(
      'Enter the required Modal configuration values to continue.',
    );

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('does not override a runtime-configured base image ref', async () => {
    vi.stubEnv(
      'DOCKER_WORKER_IMAGE',
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
    vi.stubEnv('MODAL_BASE_IMAGE_REF', 'ghcr.io/custom/base-image:pinned');

    await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'modal',
      values: {
        MODAL_TOKEN_ID: 'token-id',
        MODAL_TOKEN_SECRET: 'token-secret',
      },
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        values: [
          expect.objectContaining({ name: 'MODAL_TOKEN_ID' }),
          expect.objectContaining({ name: 'MODAL_TOKEN_SECRET' }),
        ],
      }),
    );
  });

  it('does not override an already persisted base image ref', async () => {
    vi.stubEnv(
      'DOCKER_WORKER_IMAGE',
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
    vi.stubEnv('MODAL_BASE_IMAGE_REF', '');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValueOnce([
      'MODAL_BASE_IMAGE_REF',
    ]);

    await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'modal',
      values: {
        MODAL_TOKEN_ID: 'token-id',
        MODAL_TOKEN_SECRET: 'token-secret',
      },
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        values: [
          expect.objectContaining({ name: 'MODAL_TOKEN_ID' }),
          expect.objectContaining({ name: 'MODAL_TOKEN_SECRET' }),
        ],
      }),
    );
  });

  it('starts shared E2B provisioning after saving wizard credentials', async () => {
    vi.stubEnv('DOCKER_WORKER_IMAGE', 'registry.example.com/worker:tag');

    const result = await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'e2b',
      values: {
        E2B_API_KEY: 'e2b-key',
      },
    });

    expect(result.runtimeComputeConfig.defaultProvider).toBe('e2b');
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: [{ name: 'E2B_API_KEY', value: 'e2b-key' }],
      }),
    );
    expect(mockRunComputeProvisioning).toHaveBeenCalledWith({
      provider: 'e2b',
      userId: 'setup-test-user',
      imageRef: 'registry.example.com/worker:tag',
      templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
    });
    expect(result.setupNewState.e2bTemplateBuild).toMatchObject({
      status: 'building',
      imageRef: 'registry.example.com/worker:tag',
      templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
    });
  });

  it('keeps the wizard pending when a fresh provisioning run is already in flight', async () => {
    vi.stubEnv('DOCKER_WORKER_IMAGE', 'registry.example.com/worker:tag');

    mockDbTransaction.mockImplementationOnce(async (callback) => {
      const tx = {
        select: mockTxSelect,
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(async () => undefined),
          })),
        })),
      };

      mockTxSelect
        .mockReturnValueOnce(
          createSelectChain([
            {
              setupNewState: {
                e2bTemplateBuild: {
                  status: 'building',
                  runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
                  imageRef: 'registry.example.com/worker:tag',
                  templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
                  error: null,
                  startedAt: new Date().toISOString(),
                  finishedAt: null,
                },
              },
            },
          ]),
        )
        .mockReturnValueOnce(
          createSelectChain([{ runtimeComputeConfig: null }]),
        );

      return callback(tx);
    });

    const result = await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'e2b',
      values: {
        E2B_API_KEY: 'e2b-key',
      },
    });

    expect(mockRunComputeProvisioning).not.toHaveBeenCalled();
    expect(result.setupNewState.e2bTemplateBuild).toMatchObject({
      status: 'building',
      templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
    });
  });

  it('ignores manual E2B template submissions and auto-provisions instead', async () => {
    vi.stubEnv('DOCKER_WORKER_IMAGE', 'registry.example.com/worker:tag');

    const result = await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'e2b',
      values: {
        E2B_API_KEY: 'e2b-key',
        E2B_TEMPLATE_ID: 'manual-template',
      },
    });

    expect(result.runtimeComputeConfig.defaultProvider).toBe('e2b');
    const values = mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]
      ?.values as Array<{ name: string; value: string }>;
    expect(values).toEqual(
      expect.arrayContaining([{ name: 'E2B_API_KEY', value: 'e2b-key' }]),
    );
    expect(values.map((entry) => entry.name)).not.toContain('E2B_TEMPLATE_ID');
    expect(result.setupNewState.e2bTemplateBuild).toMatchObject({
      status: 'building',
    });
  });

  it('uses a submitted worker image without sticky DOCKER_WORKER_IMAGE persist', async () => {
    const result = await saveSetupNewComputeConfigCommand(buildMockAuth(), {
      provider: 'modal',
      values: {
        MODAL_TOKEN_ID: 'token-id',
        MODAL_TOKEN_SECRET: 'token-secret',
        DOCKER_WORKER_IMAGE: 'registry.example.com/worker:tag',
      },
    });

    expect(result.runtimeComputeConfig.defaultProvider).toBe('modal');
    const values = mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]
      ?.values as Array<{ name: string; value: string }>;
    expect(values).toEqual(
      expect.arrayContaining([
        {
          name: 'MODAL_BASE_IMAGE_REF',
          value: 'registry.example.com/worker:tag',
        },
      ]),
    );
    expect(values.map((entry) => entry.name)).not.toContain(
      'DOCKER_WORKER_IMAGE',
    );
  });
});

describe('setup-new onboarding task start command', () => {
  const insertOnConflictMock = vi.fn(async () => undefined);
  const insertValuesMock = vi.fn(() => ({
    onConflictDoUpdate: insertOnConflictMock,
  }));
  const txExecuteMock = vi.fn(async () => undefined);

  function mockOnboardingTransaction({
    slackInstallation,
    slackUserMapping,
    setupNewState,
  }: {
    slackInstallation: { botAccessToken: string; teamId: string } | null;
    slackUserMapping?: { slackUserId: string } | null;
    setupNewState?: Partial<SetupNewState>;
  }) {
    mockDbTransaction.mockImplementation(async (callback) => {
      const tx = {
        execute: txExecuteMock,
        select: mockTxSelect,
        insert: vi.fn(() => ({ values: insertValuesMock })),
      };

      mockTxSelect.mockReset();
      mockTxSelect.mockReturnValueOnce(
        createSelectChain([
          {
            setupNewState: {
              version: 1,
              selectedRepositoryIds: ['repo-1'],
              ...setupNewState,
            },
          },
        ]),
      );
      if (setupNewState?.computeProvider) {
        mockTxSelect.mockReturnValueOnce(
          createSelectChain([{ runtimeComputeConfig: null }]),
        );
      }
      mockTxSelect.mockReturnValueOnce(
        createSelectChain(slackInstallation ? [slackInstallation] : []),
      );

      if (slackInstallation) {
        mockTxSelect.mockReturnValueOnce(
          createSelectChain(slackUserMapping ? [slackUserMapping] : []),
        );
      }

      return callback(tx);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelect.mockReset();
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);

    vi.mocked(getRepositories).mockResolvedValue([
      { id: 'repo-1', fullName: 'acme/api' },
    ] as Awaited<ReturnType<typeof getRepositories>>);
    vi.mocked(normalizeRepositorySelection).mockReturnValue(['repo-1']);
    vi.mocked(buildSetupNewWorkspacePayload).mockReturnValue({
      repo: 'acme/api',
    });
    vi.mocked(buildSetupNewKickoffPrompt).mockReturnValue('kickoff prompt');
    vi.mocked(appendEnvironmentDefinitionGuidance).mockReturnValue(
      'kickoff prompt',
    );
    vi.mocked(resolveTelegramRuntimeCredentials).mockResolvedValue({
      botToken: null,
      webhookSecret: null,
      botUsername: null,
    } as Awaited<ReturnType<typeof resolveTelegramRuntimeCredentials>>);
    vi.mocked(resolveDiscordRuntimeCredentials).mockResolvedValue({
      botToken: null,
      applicationId: null,
      applicationName: null,
      botUserId: null,
      botUsername: null,
      botDisplayName: null,
      identitySource: null,
      identityErrorCode: null,
    });
    vi.mocked(findDiscordDefaultDestination).mockResolvedValue(null);
    vi.mocked(findDiscordUserMappingByRoomoteUserId).mockResolvedValue(null);
    vi.mocked(findTelegramPrimaryChatId).mockResolvedValue(null);
    vi.mocked(findTeamsPrimaryConversation).mockResolvedValue(null);
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue(null);
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task-onboarding-1',
      id: 'task-run-1',
    } as unknown as Awaited<ReturnType<typeof enqueueTask>>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('launches a web onboarding task when no Slack workspace is connected', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api environment',
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/api',
            description: 'kickoff prompt',
            visibleInTranscript: false,
          }),
        }),
        initiator: { kind: 'user', userId: 'setup-test-user' },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      }),
    );
    expect(SlackNotifier).not.toHaveBeenCalled();
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewState: expect.objectContaining({
          onboardingTaskId: 'task-onboarding-1',
          slackTeamId: null,
          slackChannel: null,
          slackThreadTs: null,
        }),
      }),
    );
  });

  it('launches with bootstrap instructions instead of blocking when every selected repo is empty', async () => {
    const { getRepositoryEmptyStates } = await import('@roomote/github');
    vi.mocked(getRepositoryEmptyStates).mockResolvedValue(
      new Map([['repo-1', true]]),
    );
    mockOnboardingTransaction({ slackInstallation: null });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(buildSetupNewKickoffPrompt).toHaveBeenCalledWith(['acme/api'], {
      emptyRepositoryFullNames: ['acme/api'],
    });
  });

  it('omits the empty-repository flag when selected repos have commits', async () => {
    const { getRepositoryEmptyStates } = await import('@roomote/github');
    vi.mocked(getRepositoryEmptyStates).mockResolvedValue(
      new Map([['repo-1', false]]),
    );
    mockOnboardingTransaction({ slackInstallation: null });

    await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(buildSetupNewKickoffPrompt).toHaveBeenCalledWith(
      ['acme/api'],
      undefined,
    );
  });

  it('rejects a stale excluded compute provider before launch', async () => {
    vi.stubEnv('EXCLUDED_COMPUTE_PROVIDERS', 'docker');
    mockOnboardingTransaction({
      slackInstallation: null,
      setupNewState: { computeProvider: 'docker' },
    });

    await expect(
      startSetupNewOnboardingTaskCommand(buildMockAuth()),
    ).rejects.toThrow(
      'Selected sandbox provider is no longer available. Choose another provider before starting setup.',
    );

    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('creates the onboarding task without dispatching while first-time E2B provisioning is running', async () => {
    vi.stubEnv('E2B_TEMPLATE_ID', '');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue(['E2B_API_KEY']);
    mockOnboardingTransaction({
      slackInstallation: null,
      setupNewState: {
        computeProvider: 'e2b',
        e2bTemplateBuild: {
          status: 'building',
          runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
          imageRef: 'registry.example.com/worker:tag',
          templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
      },
    });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'setup_onboarding',
      }),
      {
        enqueue: false,
        initialTaskPhase: 'waiting_for_sandbox_provider',
        initialError: null,
      },
    );
  });

  it('includes every selected repository name in the onboarding task title', async () => {
    vi.mocked(getRepositories).mockResolvedValue([
      { id: 'repo-1', fullName: 'acme/api' },
      { id: 'repo-2', fullName: 'acme/web' },
    ] as Awaited<ReturnType<typeof getRepositories>>);
    vi.mocked(normalizeRepositorySelection).mockReturnValue([
      'repo-1',
      'repo-2',
    ]);
    mockOnboardingTransaction({
      slackInstallation: null,
      setupNewState: {
        selectedRepositoryIds: ['repo-1', 'repo-2'],
      },
    });

    await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(buildSetupEnvironmentTaskTitle).toHaveBeenCalledWith([
      'acme/api',
      'acme/web',
    ]);
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api + web environment',
      }),
    );
  });

  it('falls back to a Telegram kickoff when no Slack workspace is connected but a primary chat exists', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const telegramPostMessage = vi.fn(async () => ({
      provider: 'telegram' as const,
      channelId: '8846357662',
      messageId: '900',
    }));
    const telegramCreateForumTopic = vi.fn(async () => ({
      messageThreadId: '77',
      name: 'Set up Roomote',
    }));

    vi.mocked(resolveTelegramRuntimeCredentials).mockResolvedValue({
      botToken: 'bot-token',
      webhookSecret: null,
      botUsername: null,
    } as Awaited<ReturnType<typeof resolveTelegramRuntimeCredentials>>);
    vi.mocked(findTelegramPrimaryChatId).mockResolvedValue('8846357662');
    vi.mocked(TelegramCommunicationProvider).mockImplementation(
      function (this: unknown) {
        return {
          getBotInfo: vi.fn(async () => ({ hasTopicsEnabled: true })),
          createForumTopic: telegramCreateForumTopic,
          postMessage: telegramPostMessage,
        } as unknown as TelegramCommunicationProvider;
      },
    );

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(telegramPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '8846357662',
        threadId: '77',
      }),
    );
    expect(telegramCreateForumTopic).toHaveBeenCalledWith({
      channelId: '8846357662',
      name: 'Set up Roomote',
    });
    expect(SlackNotifier).not.toHaveBeenCalled();
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api environment',
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            description: 'kickoff prompt',
            visibleInTranscript: false,
            communicationProvider: 'telegram',
            communicationChannelId: '8846357662',
            communicationMessageId: '900',
            communicationThreadId: '77',
            telegramTaskTopic: true,
          }),
        }),
        initiator: { kind: 'user', userId: 'setup-test-user' },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewState: expect.objectContaining({
          onboardingTaskId: 'task-onboarding-1',
          slackChannel: null,
          chatHandoffProvider: 'telegram',
          chatHandoffChannelId: '8846357662',
          chatHandoffThreadId: '77',
          chatHandoffServiceUrl: null,
        }),
      }),
    );
  });

  it('creates a Discord task thread for the setup kickoff and persists handoff metadata', async () => {
    mockOnboardingTransaction({ slackInstallation: null });
    const createTaskThread = vi.fn(async () => ({
      channelId: 'thread-1',
      parentChannelId: 'channel-1',
      name: 'Set up Roomote',
      kind: 'thread' as const,
      messageId: 'message-1',
    }));
    vi.mocked(resolveDiscordRuntimeCredentials).mockResolvedValue({
      botToken: 'discord-token',
      applicationId: 'app-1',
      applicationName: 'Roomote',
      botUserId: 'bot-1',
      botUsername: 'roomote',
      botDisplayName: 'Roomote',
      identitySource: 'live',
      identityErrorCode: null,
    });
    vi.mocked(findDiscordDefaultDestination).mockResolvedValue({
      installationId: 'installation-1',
      guildId: 'guild-1',
      guildName: 'Acme',
      channelId: 'channel-1',
      channelName: 'roomote',
      channelType: 0,
    });
    vi.mocked(DiscordCommunicationProvider).mockImplementation(function () {
      return { createTaskThread } as unknown as DiscordCommunicationProvider;
    });

    await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(createTaskThread).toHaveBeenCalledWith({
      channelId: 'channel-1',
      name: 'Set up Roomote',
      initialText: expect.any(String),
    });
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'discord',
            communicationGuildId: 'guild-1',
            communicationChannelId: 'channel-1',
            communicationThreadId: 'thread-1',
            discordTaskThread: true,
            communicationMessageId: 'message-1',
          }),
        }),
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewState: expect.objectContaining({
          chatHandoffProvider: 'discord',
          chatHandoffChannelId: 'channel-1',
          chatHandoffThreadId: 'thread-1',
          chatHandoffServiceUrl: null,
        }),
      }),
    );
  });

  it('sends the setup kickoff to the linked Discord user without requiring a server destination', async () => {
    mockOnboardingTransaction({ slackInstallation: null });
    const createDirectMessage = vi.fn(async () => ({
      id: 'dm-channel-1',
      name: 'Direct message',
      type: 1,
    }));
    const postMessage = vi.fn(async () => ({
      provider: 'discord' as const,
      channelId: 'dm-channel-1',
      messageId: 'dm-message-1',
    }));
    vi.mocked(resolveDiscordRuntimeCredentials).mockResolvedValue({
      botToken: 'discord-token',
      applicationId: 'app-1',
      applicationName: 'Roomote',
      botUserId: 'bot-1',
      botUsername: 'roomote',
      botDisplayName: 'Roomote',
      identitySource: 'live',
      identityErrorCode: null,
    });
    vi.mocked(findDiscordUserMappingByRoomoteUserId).mockResolvedValue({
      id: 'mapping-1',
      userId: 'setup-test-user',
      discordUserId: 'discord-user-1',
      discordUsername: 'setup-user',
      discordGlobalName: 'Setup User',
      discordDmChannelId: null,
      createdAt: new Date('2026-07-13T00:00:00.000Z'),
      updatedAt: new Date('2026-07-13T00:00:00.000Z'),
    });
    vi.mocked(DiscordCommunicationProvider).mockImplementation(function () {
      return {
        createDirectMessage,
        postMessage,
      } as unknown as DiscordCommunicationProvider;
    });

    await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(createDirectMessage).toHaveBeenCalledWith('discord-user-1');
    expect(postMessage).toHaveBeenCalledWith({
      channelId: 'dm-channel-1',
      text: expect.any(String),
      textFormat: 'markdown',
    });
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'discord',
            communicationChannelId: 'dm-channel-1',
            communicationMessageId: 'dm-message-1',
          }),
        }),
      }),
    );
    const payload = vi.mocked(enqueueTask).mock.calls[0]?.[0].task.payload;
    expect(payload).not.toHaveProperty('communicationGuildId');
    expect(payload).not.toHaveProperty('communicationThreadId');
    expect(payload).not.toHaveProperty('discordTaskThread');
  });

  it('falls back to a Teams kickoff when no Slack or Telegram destination exists but a primary conversation was captured', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const teamsPostMessage = vi.fn(async () => ({
      provider: 'teams' as const,
      channelId: '19:channel@thread.tacv2',
      messageId: '1751000000000',
    }));

    vi.mocked(findTeamsPrimaryConversation).mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      conversationType: 'channel',
    });
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue({
      postMessage: teamsPostMessage,
    } as unknown as Awaited<
      ReturnType<typeof createTeamsCommunicationProviderFromRuntimeCredentials>
    >);

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(teamsPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:channel@thread.tacv2',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      }),
    );
    expect(SlackNotifier).not.toHaveBeenCalled();
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api environment',
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            description: 'kickoff prompt',
            visibleInTranscript: false,
            communicationProvider: 'teams',
            communicationChannelId: '19:channel@thread.tacv2',
            communicationMessageId: '1751000000000',
            communicationThreadId: '1751000000000',
            communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
          }),
        }),
        initiator: { kind: 'user', userId: 'setup-test-user' },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewState: expect.objectContaining({
          onboardingTaskId: 'task-onboarding-1',
          slackChannel: null,
          chatHandoffProvider: 'teams',
          chatHandoffChannelId: '19:channel@thread.tacv2',
          chatHandoffThreadId: '1751000000000',
          chatHandoffServiceUrl: 'https://smba.trafficmanager.net/amer/',
        }),
      }),
    );
  });

  it('falls back to a web onboarding task when a Teams conversation exists but bot credentials are missing', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    vi.mocked(findTeamsPrimaryConversation).mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      conversationType: 'channel',
    });

    try {
      const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

      expect(result.taskId).toBe('task-onboarding-1');
      expect(enqueueTask).toHaveBeenCalledTimes(1);

      const enqueueInput = vi.mocked(enqueueTask).mock.calls[0]?.[0];
      expect(enqueueInput?.task.payload).toBeDefined();
      expect(enqueueInput?.task.payload).not.toHaveProperty(
        'communicationProvider',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Teams bot credentials could not be resolved'),
      );
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          setupNewState: expect.objectContaining({
            onboardingTaskId: 'task-onboarding-1',
            chatHandoffProvider: null,
            chatHandoffChannelId: null,
            chatHandoffThreadId: null,
            chatHandoffServiceUrl: null,
          }),
        }),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('falls back to a web onboarding task when the Teams kickoff post fails', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const teamsPostMessage = vi.fn(async () => {
      throw new Error('Teams post failed');
    });

    vi.mocked(findTeamsPrimaryConversation).mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      conversationType: 'channel',
    });
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue({
      postMessage: teamsPostMessage,
    } as unknown as Awaited<
      ReturnType<typeof createTeamsCommunicationProviderFromRuntimeCredentials>
    >);

    try {
      const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

      expect(result.taskId).toBe('task-onboarding-1');
      expect(teamsPostMessage).toHaveBeenCalled();
      expect(enqueueTask).toHaveBeenCalledTimes(1);

      const enqueueInput = vi.mocked(enqueueTask).mock.calls[0]?.[0];
      expect(enqueueInput?.task.payload).toBeDefined();
      expect(enqueueInput?.task.payload).not.toHaveProperty(
        'communicationProvider',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to post the Teams setup kickoff'),
        expect.any(Error),
      );
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          setupNewState: expect.objectContaining({
            onboardingTaskId: 'task-onboarding-1',
            chatHandoffProvider: null,
            chatHandoffChannelId: null,
            chatHandoffThreadId: null,
            chatHandoffServiceUrl: null,
          }),
        }),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('falls back to a web onboarding task when the Teams kickoff post returns no message id', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const teamsPostMessage = vi.fn(async () => ({
      provider: 'teams' as const,
      channelId: '19:channel@thread.tacv2',
      messageId: '',
    }));

    vi.mocked(findTeamsPrimaryConversation).mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      conversationType: 'channel',
    });
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue({
      postMessage: teamsPostMessage,
    } as unknown as Awaited<
      ReturnType<typeof createTeamsCommunicationProviderFromRuntimeCredentials>
    >);

    try {
      const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

      expect(result.taskId).toBe('task-onboarding-1');
      expect(teamsPostMessage).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('returned no message id'),
      );

      const enqueueInput = vi.mocked(enqueueTask).mock.calls[0]?.[0];
      expect(enqueueInput?.task.payload).toBeDefined();
      expect(enqueueInput?.task.payload).not.toHaveProperty(
        'communicationProvider',
      );
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          setupNewState: expect.objectContaining({
            chatHandoffProvider: null,
            chatHandoffChannelId: null,
          }),
        }),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('applies the selected setup model to web onboarding tasks', async () => {
    mockOnboardingTransaction({
      slackInstallation: null,
      setupNewState: {
        selectedModelId: 'openrouter/z-ai/glm-5.2',
      },
    });

    await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api environment',
        task: expect.objectContaining({
          harness: 'opencode-server',
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            harnessModelOverrides: {
              'opencode-server': 'openrouter/z-ai/glm-5.2',
            },
          }),
        }),
        initiator: { kind: 'user', userId: 'setup-test-user' },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });

  it('falls back to a web onboarding task when the admin has no Slack user mapping', async () => {
    mockOnboardingTransaction({
      slackInstallation: { botAccessToken: 'xoxb-token', teamId: 'T1' },
      slackUserMapping: null,
    });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(SlackNotifier).not.toHaveBeenCalled();
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
        }),
        initiator: { kind: 'user', userId: 'setup-test-user' },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });

  it('keeps the Slack DM handoff when Slack is connected and mapped', async () => {
    mockOnboardingTransaction({
      slackInstallation: { botAccessToken: 'xoxb-token', teamId: 'T1' },
      slackUserMapping: { slackUserId: 'U1' },
    });

    const openConversationMock = vi.fn(async () => 'D1');
    const postMessageMock = vi.fn(async () => '171.0001');
    vi.mocked(SlackNotifier).mockImplementation(function (this: unknown) {
      return {
        openConversation: openConversationMock,
        postMessage: postMessageMock,
        deleteMessage: vi.fn(),
      } as unknown as InstanceType<typeof SlackNotifier>;
    });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(openConversationMock).toHaveBeenCalledWith('U1');
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api environment',
        task: expect.objectContaining({
          type: TaskPayloadKind.SlackAppMention,
          payload: expect.objectContaining({
            channel: 'D1',
            user: 'U1',
            ts: '171.0001',
            thread_ts: '171.0001',
          }),
        }),
        initiator: { kind: 'user', userId: 'setup-test-user' },
        workflow: 'setup_onboarding',
        surface: 'slack',
        trigger: 'manual',
        channels: {
          slackChannelId: 'D1',
          slackThreadTs: '171.0001',
        },
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewState: expect.objectContaining({
          onboardingTaskId: 'task-onboarding-1',
          slackTeamId: 'T1',
          slackChannel: 'D1',
          slackThreadTs: '171.0001',
        }),
      }),
    );
  });
});
