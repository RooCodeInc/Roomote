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
  mockInvalidateTelegramRuntimeCredentialsCache,
  mockValidateSetupModelProviderCredentials,
  mockEnqueueAutomationRecommendations,
  mockEnqueueAutomationRecommendationInitialRun,
  mockUpsertAutomation,
  mockCaptureActivationAutomationChanged,
  mockTriggerAutomationCommand,
  mockTriggerCustomAutomationCommand,
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
  mockInvalidateTelegramRuntimeCredentialsCache: vi.fn(),
  mockValidateSetupModelProviderCredentials: vi
    .fn()
    .mockResolvedValue(undefined),
  mockEnqueueAutomationRecommendations: vi.fn(async () => undefined),
  mockEnqueueAutomationRecommendationInitialRun: vi.fn(async () => undefined),
  mockUpsertAutomation: vi.fn(async () => undefined),
  mockCaptureActivationAutomationChanged: vi.fn(async () => undefined),
  mockTriggerAutomationCommand: vi.fn(async () => ({
    outcome: 'launched' as const,
    taskId: 'task-recommendation-1',
  })),
  mockTriggerCustomAutomationCommand: vi.fn(async () => ({
    outcome: 'launched' as const,
    taskId: 'task-custom-recommendation-1',
  })),
}));

vi.mock('../task-models/provider-validation', () => ({
  validateSetupModelProviderCredentials:
    mockValidateSetupModelProviderCredentials,
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

vi.mock('@roomote/gitea', () => ({
  normalizeGiteaBaseUrl: (value: string) =>
    value.startsWith('http') ? value : `https://${value}`,
  resolveGiteaBaseUrl: mockResolveGiteaBaseUrl,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureActivationAutomationChanged: mockCaptureActivationAutomationChanged,
  captureTaskSettled: vi.fn(),
}));

vi.mock('../automations/trigger-agent', () => ({
  triggerAutomationCommand: mockTriggerAutomationCommand,
}));

vi.mock('../automations/custom-automations', () => ({
  triggerCustomAutomationCommand: mockTriggerCustomAutomationCommand,
}));

vi.mock('@roomote/sdk/server', () => ({
  AUTOMATION_RECOMMENDATION_REPOSITORY_CAP: 10,
  buildAutomationRecommendationFingerprint: vi.fn(
    (repositoryIds: string[], provider: string | null) =>
      `${provider ?? 'none'}:${repositoryIds.join(',')}`,
  ),
  enqueueAutomationRecommendations: mockEnqueueAutomationRecommendations,
  enqueueAutomationRecommendationInitialRun:
    mockEnqueueAutomationRecommendationInitialRun,
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
  gte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  resolveSavedWorkerImage: mockResolveSavedWorkerImage,
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
  purgeSavedDeploymentWorkerImage: vi.fn(async () => undefined),
  invalidateTeamsBotRuntimeCredentialsCache: vi.fn(),
  invalidateTelegramRuntimeCredentialsCache:
    mockInvalidateTelegramRuntimeCredentialsCache,
  slackInstallations: {},
  slackUserMappings: {},
  sql: vi.fn(),
  users: {},
  workItems: {},
  pullRequestFacts: {
    repositoryId: 'pull_request_facts.repository_id',
    updatedAtRemote: 'pull_request_facts.updated_at_remote',
  },
  upsertAutomation: mockUpsertAutomation,
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
  startSetupRecommendationsCommand,
  applySetupRecommendationsCommand,
  skipSetupRecommendationsCommand,
  trackSetupBootstrapWelcomeSeenCommand,
  trackSetupCommsStateCommand,
  trackSetupWelcomeSeenCommand,
  chooseSetupTrialInferenceCommand,
  importTrialInferenceKeyIfNeeded,
} from './index';
import {
  DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES,
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLES,
  WORKER_RUNTIME_SCHEMA_VERSION,
  type SetupNewState,
} from '@roomote/types';
import { invalidateTeamsBotRuntimeCredentialsCache } from '@roomote/db/server';
import { TeamsBotCredentialValidationError } from '@roomote/communication/teams-credential-validation';
import { getRepositories } from '@/lib/server';
import { normalizeRepositorySelection } from '@/lib/setup-new';

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

function createGroupBySelectChain(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        groupBy: vi.fn(async () => result),
      })),
    })),
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
    expect(
      mockInvalidateTelegramRuntimeCredentialsCache,
    ).toHaveBeenCalledOnce();
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

describe('setup recommendation commands', () => {
  const insertOnConflictMock = vi.fn(async () => undefined);
  const insertValuesMock = vi.fn(() => ({
    onConflictDoUpdate: insertOnConflictMock,
  }));
  const txExecuteMock = vi.fn(async () => undefined);

  function mockRecommendationTransaction(
    setupNewState: Partial<SetupNewState> = {},
  ) {
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
              selectedRepositoryIds: [],
              ...setupNewState,
            },
          },
        ]),
      );

      return callback(tx);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelect.mockReset();
    mockTxSelect.mockReturnValue(createGroupBySelectChain([]));
    vi.mocked(getRepositories).mockResolvedValue([
      {
        id: 'repo-1',
        fullName: 'acme/api',
        sourceControlProvider: 'github',
      },
    ] as Awaited<ReturnType<typeof getRepositories>>);
    vi.mocked(normalizeRepositorySelection).mockImplementation((repositories) =>
      repositories.map((repository) => repository.id),
    );
  });

  it('scores the most active connected repositories', async () => {
    vi.mocked(getRepositories).mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        id: `repo-${index + 1}`,
        fullName: `acme/repo-${String(index + 1).padStart(2, '0')}`,
        sourceControlProvider: 'github' as const,
      })) as Awaited<ReturnType<typeof getRepositories>>,
    );
    mockTxSelect.mockReturnValueOnce(
      createGroupBySelectChain([
        { repositoryId: 'repo-11', activity: 10 },
        { repositoryId: 'repo-10', activity: 5 },
      ]),
    );
    mockRecommendationTransaction();

    await startSetupRecommendationsCommand(buildMockAuth());

    expect(mockEnqueueAutomationRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryIds: [
          'repo-11',
          'repo-10',
          'repo-1',
          'repo-2',
          'repo-3',
          'repo-4',
          'repo-5',
          'repo-6',
          'repo-7',
          'repo-8',
        ],
      }),
    );
  });

  it('starts recommendations without a persisted environment selection', async () => {
    mockRecommendationTransaction({ selectedRepositoryIds: [] });

    const result = await startSetupRecommendationsCommand(buildMockAuth());

    expect(result.status).toBe('pending');
    expect(mockEnqueueAutomationRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryIds: ['repo-1'] }),
    );
  });

  it('applies enabled recommendations before setup continues', async () => {
    mockRecommendationTransaction({
      automationRecommendations: {
        version: 1,
        inputFingerprint: 'recommendation-fingerprint',
        catalogVersion: 1,
        status: 'ready',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        partial: false,
        errorCode: null,
        dismissed: false,
        recommendations: [
          {
            id: 'built-in.review-code:1',
            candidateId: 'built-in.review-code',
            rank: 1,
            score: 1,
            explanation: 'Review PRs automatically.',
            enabled: true,
            lastRunTaskId: null,
            automationId: null,
          },
          {
            id: 'built-in.ci-failure-triage:2',
            candidateId: 'built-in.ci-failure-triage',
            rank: 2,
            score: 1,
            explanation: 'Fix broken builds.',
            enabled: true,
            lastRunTaskId: null,
            automationId: null,
          },
        ],
      },
    });

    const result = await applySetupRecommendationsCommand(buildMockAuth());

    expect(mockUpsertAutomation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'review_code', enabled: true }),
    );
    expect(mockUpsertAutomation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'ci_failure_triage', enabled: true }),
    );
    expect(mockCaptureActivationAutomationChanged).toHaveBeenCalledWith(
      'enabled',
      'review_code',
    );
    expect(mockCaptureActivationAutomationChanged).toHaveBeenCalledWith(
      'enabled',
      'ci_failure_triage',
    );
    expect(mockEnqueueAutomationRecommendationInitialRun).toHaveBeenCalledWith(
      {
        fingerprint: 'recommendation-fingerprint',
        recommendationId: 'built-in.ci-failure-triage:2',
      },
      5 * 60 * 1_000,
    );
    expect(result?.applicationState).toBe('applied');
  });

  it('keeps a skipped pending batch unapplied and disabled', async () => {
    mockRecommendationTransaction({
      automationRecommendations: {
        version: 1,
        inputFingerprint: 'recommendation-fingerprint',
        catalogVersion: 1,
        status: 'pending',
        startedAt: new Date().toISOString(),
        completedAt: null,
        partial: false,
        errorCode: null,
        dismissed: false,
        applicationState: 'pending',
        recommendations: [
          {
            id: 'built-in.ci-failure-triage:1',
            candidateId: 'built-in.ci-failure-triage',
            rank: 1,
            score: 1,
            explanation: 'Fix broken builds.',
            enabled: true,
            lastRunTaskId: null,
            automationId: null,
          },
        ],
      },
    });

    const result = await skipSetupRecommendationsCommand(buildMockAuth());

    expect(result).toMatchObject({
      applicationState: 'skipped',
      recommendations: [
        expect.objectContaining({ enabled: false, applied: false }),
      ],
    });
  });
});

describe('chooseSetupTrialInferenceCommand', () => {
  function createTxStub(row: Record<string, unknown>) {
    // Records only the config upserts; the setup-state save and the bare row
    // insert that backs the FOR UPDATE lock stay out of assertions.
    const inserted: Array<Record<string, unknown>> = [];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [row]),
            for: vi.fn(async () => [row]),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          if ('runtimeModelConfig' in values || 'taskModelSettings' in values) {
            inserted.push(values);
          }
          return {
            onConflictDoUpdate: vi.fn(async () => undefined),
            onConflictDoNothing: vi.fn(async () => undefined),
          };
        }),
      })),
    };

    // The import's lock-free pre-check reads setup state through the plain
    // `db` handle (whose `select` is mockTxSelect) before any transaction
    // opens, so serve it the same row the transaction stub returns.
    mockTxSelect.mockImplementation(() => tx.select());

    return { tx, inserted };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    // Hermetic against the host environment: a developer or CI shell with
    // role models or provider keys set must not change these outcomes.
    for (const role of TASK_MODEL_ROLES) {
      vi.stubEnv(TASK_MODEL_ROLE_DESCRIPTORS[role].modelEnvVar, '');
    }
    for (const name of DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('seeds the Efficient Roomote defaults and records the managed provider choice', async () => {
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'R_TRIAL_OPENROUTER_API_KEY',
    ]);
    const { tx, inserted } = createTxStub({
      setupNewState: {},
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    const result = await chooseSetupTrialInferenceCommand(buildMockAuth());

    expect(result.setupNewState.modelProvider).toBe('roomote');
    const runtimeModelConfigInsert = inserted.find(
      (values) => 'runtimeModelConfig' in values,
    );
    const taskModelSettingsInsert = inserted.find(
      (values) => 'taskModelSettings' in values,
    );

    expect(runtimeModelConfigInsert?.runtimeModelConfig).toMatchObject({
      roomoteModel: 'roomote/openai/gpt-5.6-luna',
      roomoteSmallModel: 'roomote/openai/gpt-5.6-luna',
      roomotePlanningModel: 'roomote/openai/gpt-5.6-luna',
    });
    expect(taskModelSettingsInsert?.taskModelSettings).toMatchObject({
      defaultModelId: 'roomote/openai/gpt-5.6-luna',
    });
  });

  it('refuses when no trial key was ever delivered or stored', async () => {
    const { tx } = createTxStub({
      setupNewState: {},
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    await expect(
      chooseSetupTrialInferenceCommand(buildMockAuth()),
    ).rejects.toThrow('Free trial inference is not available');
  });

  it('refuses after the stored key was deleted, even with the variable still injected', async () => {
    // Disabling the trial = deleting the Roomote inference provider's stored
    // key. The import marker keeps the still-injected env variable from
    // resurrecting it.
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    const { tx } = createTxStub({
      setupNewState: { trialInferenceKeyImportedAt: '2026-08-27T00:00:00Z' },
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    await expect(
      chooseSetupTrialInferenceCommand(buildMockAuth()),
    ).rejects.toThrow('Free trial inference is not available');
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('imports the delivered key into Settings storage exactly once', async () => {
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    const { tx } = createTxStub({
      setupNewState: {},
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    await importTrialInferenceKeyIfNeeded('setup-test-user');

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        values: [{ name: 'R_TRIAL_OPENROUTER_API_KEY', value: 'sk-trial' }],
      }),
    );
  });

  it('refuses when an operator provider is already connected', async () => {
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'R_TRIAL_OPENROUTER_API_KEY',
    ]);
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-operator');
    const { tx, inserted } = createTxStub({
      setupNewState: {},
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    await expect(
      chooseSetupTrialInferenceCommand(buildMockAuth()),
    ).rejects.toThrow('already connected');
    expect(inserted).toEqual([]);
  });

  it('no-ops when model choices already exist', async () => {
    // A repeat click: the trial was already chosen (`modelProvider` recorded)
    // and its models seeded. A bare task-model-settings row alone is NOT a
    // choice — deleting the last provider leaves one behind, and treating it
    // as a choice would silently skip seeding.
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'R_TRIAL_OPENROUTER_API_KEY',
    ]);
    const { tx, inserted } = createTxStub({
      setupNewState: { modelProvider: 'roomote' },
      runtimeModelConfig: null,
      taskModelSettings: {
        allowedModelIds: ['roomote/openai/gpt-5.6-terra'],
        defaultModelId: 'roomote/openai/gpt-5.6-terra',
      },
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    await chooseSetupTrialInferenceCommand(buildMockAuth());

    expect(inserted).toEqual([]);
  });

  it('seeds over a leftover task-model-settings row after the last provider was deleted', async () => {
    // Deleting the last provider nulls `modelProvider` and role config but
    // leaves a task-model-settings row behind; the trial choice must still
    // seed rather than silently no-op with a success payload.
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'R_TRIAL_OPENROUTER_API_KEY',
    ]);
    const { tx, inserted } = createTxStub({
      setupNewState: { trialInferenceKeyImportedAt: '2026-08-27T00:00:00Z' },
      runtimeModelConfig: null,
      taskModelSettings: {
        models: [],
        allowedModelIds: [],
        defaultModelId: '',
      },
    });
    mockResolveDeploymentEnvVar.mockResolvedValue('sk-trial');
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    const result = await chooseSetupTrialInferenceCommand(buildMockAuth());

    expect(result.setupNewState.modelProvider).toBe('roomote');
    expect(
      inserted.find((values) => 'taskModelSettings' in values),
    ).toBeDefined();
  });

  it('re-imports a rotated injected key while the stored key still exists', async () => {
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-rotated');
    const { tx } = createTxStub({
      setupNewState: { trialInferenceKeyImportedAt: '2026-08-27T00:00:00Z' },
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockResolveDeploymentEnvVar.mockResolvedValue('sk-old');
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    await importTrialInferenceKeyIfNeeded('setup-test-user');

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        values: [{ name: 'R_TRIAL_OPENROUTER_API_KEY', value: 'sk-rotated' }],
      }),
    );
  });

  it('seeds despite a role-model env override, which keeps winning at runtime', async () => {
    vi.stubEnv('R_TRIAL_OPENROUTER_API_KEY', 'sk-trial');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'R_TRIAL_OPENROUTER_API_KEY',
    ]);
    vi.stubEnv('R_PLANNING_MODEL', 'anthropic/claude-opus-5');
    const { tx, inserted } = createTxStub({
      setupNewState: {},
      runtimeModelConfig: null,
      taskModelSettings: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    const result = await chooseSetupTrialInferenceCommand(buildMockAuth());

    expect(result.setupNewState.modelProvider).toBe('roomote');
    expect(
      inserted.find((values) => 'runtimeModelConfig' in values),
    ).toBeDefined();
  });
});
