import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

const {
  mockTxSelect,
  mockDbTransaction,
  mockUpsertDeploymentEnvironmentVariables,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
  mockGetSetupBootstrapState,
  mockSetupTokenState,
  mockRunComputeProvisioning,
  mockResolveSavedWorkerImage,
  mockResolveGiteaBaseUrl,
  mockValidateGiteaToken,
} = vi.hoisted(() => ({
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
  mockResolveSavedWorkerImage: vi.fn().mockResolvedValue(null),
  mockResolveGiteaBaseUrl: vi
    .fn()
    .mockResolvedValue('https://gitea.example.com'),
  mockValidateGiteaToken: vi.fn().mockResolvedValue({ status: 'valid' }),
}));

vi.mock('../compute/compute-provisioning', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../compute/compute-provisioning')>();

  return {
    ...actual,
    runComputeProvisioning: mockRunComputeProvisioning,
  };
});

vi.mock('@roomote/github', () => ({
  getRepositoryEmptyStates: vi.fn(async () => new Map()),
}));

vi.mock('@roomote/gitea', () => ({
  resolveGiteaBaseUrl: mockResolveGiteaBaseUrl,
  validateGiteaToken: mockValidateGiteaToken,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(
    async () => null,
  ),
  findTelegramPrimaryChatId: vi.fn(async () => null),
  findTeamsPrimaryConversation: vi.fn(async () => null),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  cloudJobs: {},
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
  purgeSavedDeploymentWorkerImage: vi.fn(async () => undefined),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: null,
    webhookSecret: null,
    botUsername: null,
  })),
  setupNewQueuedTasks: {},
  slackInstallations: {},
  slackUserMappings: {},
  sql: vi.fn(),
  syncSetupQualificationBlock: vi.fn(),
  taskSuggestions: {},
  users: {},
}));

vi.mock('@/lib/server', () => ({
  getLatestCloudJobsByTaskId: vi.fn(),
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
} from './index';
import { CloudTaskType } from '@roomote/types';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  findTelegramPrimaryChatId,
  findTeamsPrimaryConversation,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';
import { getRepositories } from '@/lib/server';
import {
  appendEnvironmentDefinitionGuidance,
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
    featureFlags: {} as Record<FeatureFlag, boolean>,
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
    process.env.E2B_TEMPLATE_ID = '';
    process.env.DAYTONA_SNAPSHOT_NAME = '';

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
        SLACK_CLIENT_ID: 'client-id',
        SLACK_CLIENT_SECRET: 'client-secret',
        SLACK_SIGNING_SECRET: 'signing-secret',
      },
    });

    expect(result.setupNewState.authProvider).toBe('slack');
    expect(mockGetSetupBootstrapState).not.toHaveBeenCalled();
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: expect.arrayContaining([
          expect.objectContaining({ name: 'SLACK_CLIENT_ID' }),
          expect.objectContaining({ name: 'SLACK_CLIENT_SECRET' }),
          expect.objectContaining({ name: 'SLACK_SIGNING_SECRET' }),
        ]),
      }),
    );
  });

  it('still blocks anonymous bootstrap saves once bootstrap closes', async () => {
    mockGetSetupBootstrapState.mockResolvedValue({ setupOpen: false });

    await expect(
      saveSetupBootstrapAuthConfigCommand({
        provider: 'slack',
        values: {
          SLACK_CLIENT_ID: 'client-id',
          SLACK_CLIENT_SECRET: 'client-secret',
          SLACK_SIGNING_SECRET: 'signing-secret',
        },
      }),
    ).rejects.toThrow('Initial setup is no longer open.');

    expect(mockGetSetupBootstrapState).toHaveBeenCalledTimes(1);
    expect(mockDbTransaction).not.toHaveBeenCalled();
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
          SLACK_CLIENT_ID: 'client-id',
          SLACK_CLIENT_SECRET: 'client-secret',
          SLACK_SIGNING_SECRET: 'signing-secret',
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
    mockValidateGiteaToken.mockResolvedValue({ status: 'valid' });

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
          GITEA_BASE_URL: 'https://gitea.example.com',
          GITEA_TOKEN: 'gitea-token',
        },
      },
    );

    expect(result.setupNewState.sourceControlProvider).toBe('gitea');
    expect(mockValidateGiteaToken).toHaveBeenCalledWith({
      token: 'gitea-token',
      baseUrl: 'https://gitea.example.com',
    });
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'setup-test-user',
        values: expect.arrayContaining([
          expect.objectContaining({ name: 'GITEA_BASE_URL' }),
          expect.objectContaining({ name: 'GITEA_TOKEN' }),
        ]),
      }),
    );
  });

  it('preserves existing saved values when fields are left blank', async () => {
    mockTxSelect.mockReset();
    mockTxSelect
      .mockReturnValueOnce(createSelectChain([{ setupNewState: {} }]))
      .mockReturnValueOnce(
        createFromOnlySelectChain([{ name: 'GITEA_TOKEN' }]),
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
      'Enter the required Gitea configuration values to continue.',
    );

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('rejects invalid Gitea tokens before saving config', async () => {
    mockValidateGiteaToken.mockResolvedValue({
      status: 'invalid',
      error: 'Gitea rejected the token.',
    });

    await expect(
      saveSetupNewSourceControlConfigCommand(buildMockAuth(), {
        provider: 'gitea',
        values: {
          GITEA_BASE_URL: 'https://gitea.example.com',
          GITEA_TOKEN: 'gitea-token',
        },
      }),
    ).rejects.toThrow('Gitea rejected the token.');

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
      templateRef: 'roomote-worker:tag',
    });
    expect(result.setupNewState.e2bTemplateBuild).toMatchObject({
      status: 'building',
      imageRef: 'registry.example.com/worker:tag',
      templateRef: 'roomote-worker:tag',
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
                  imageRef: 'registry.example.com/worker:tag',
                  templateRef: 'roomote-worker:tag',
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
      templateRef: 'roomote-worker:tag',
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
    setupNewState?: {
      selectedModelId?: string | null;
      selectedRepositoryIds?: string[];
      version?: number;
    };
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
    vi.mocked(findTelegramPrimaryChatId).mockResolvedValue(null);
    vi.mocked(findTeamsPrimaryConversation).mockResolvedValue(null);
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue(null);
    vi.mocked(enqueueCloudTask).mockResolvedValue({
      taskId: 'task-onboarding-1',
      id: 'cloud-job-1',
    } as unknown as Awaited<ReturnType<typeof enqueueCloudTask>>);
  });

  it('launches a web onboarding task when no Slack workspace is connected', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(enqueueCloudTask).toHaveBeenCalledTimes(1);
    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
        payload: expect.objectContaining({
          repo: 'acme/api',
          description: 'kickoff prompt',
          visibleInTranscript: false,
        }),
      }),
      { launchClass: 'human' },
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

  it('falls back to a Telegram kickoff when no Slack workspace is connected but a primary chat exists', async () => {
    mockOnboardingTransaction({ slackInstallation: null });

    const telegramPostMessage = vi.fn(async () => ({
      provider: 'telegram' as const,
      channelId: '8846357662',
      messageId: '900',
    }));

    vi.mocked(resolveTelegramRuntimeCredentials).mockResolvedValue({
      botToken: 'bot-token',
      webhookSecret: null,
      botUsername: null,
    } as Awaited<ReturnType<typeof resolveTelegramRuntimeCredentials>>);
    vi.mocked(findTelegramPrimaryChatId).mockResolvedValue('8846357662');
    vi.mocked(TelegramCommunicationProvider).mockImplementation(function (
      this: unknown,
    ) {
      return {
        postMessage: telegramPostMessage,
      } as unknown as TelegramCommunicationProvider;
    });

    const result = await startSetupNewOnboardingTaskCommand(buildMockAuth());

    expect(result.taskId).toBe('task-onboarding-1');
    expect(telegramPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '8846357662' }),
    );
    expect(SlackNotifier).not.toHaveBeenCalled();
    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
        payload: expect.objectContaining({
          description: 'kickoff prompt',
          visibleInTranscript: false,
          communicationProvider: 'telegram',
          communicationChannelId: '8846357662',
          communicationMessageId: '900',
        }),
      }),
      { launchClass: 'human' },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewState: expect.objectContaining({
          onboardingTaskId: 'task-onboarding-1',
          slackChannel: null,
          chatHandoffProvider: 'telegram',
          chatHandoffChannelId: '8846357662',
          chatHandoffThreadId: '900',
          chatHandoffServiceUrl: null,
        }),
      }),
    );
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
    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
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
      { launchClass: 'human' },
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
      expect(enqueueCloudTask).toHaveBeenCalledTimes(1);

      const enqueueInput = vi.mocked(enqueueCloudTask).mock.calls[0]?.[0];
      expect(enqueueInput?.payload).not.toHaveProperty('communicationProvider');
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
      expect(enqueueCloudTask).toHaveBeenCalledTimes(1);

      const enqueueInput = vi.mocked(enqueueCloudTask).mock.calls[0]?.[0];
      expect(enqueueInput?.payload).not.toHaveProperty('communicationProvider');
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

      const enqueueInput = vi.mocked(enqueueCloudTask).mock.calls[0]?.[0];
      expect(enqueueInput?.payload).not.toHaveProperty('communicationProvider');
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

    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'opencode-server',
        type: CloudTaskType.StandardTask,
        payload: expect.objectContaining({
          harnessModelOverrides: {
            'opencode-server': 'openrouter/z-ai/glm-5.2',
          },
        }),
      }),
      { launchClass: 'human' },
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
    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
      }),
      { launchClass: 'human' },
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
    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.SlackAppMention,
        payload: expect.objectContaining({
          channel: 'D1',
          user: 'U1',
          ts: '171.0001',
          thread_ts: '171.0001',
        }),
      }),
      { launchClass: 'human' },
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
