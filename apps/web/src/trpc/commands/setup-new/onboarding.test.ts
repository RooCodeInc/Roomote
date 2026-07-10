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
  purgeSavedDeploymentWorkerImage: vi.fn(async () => undefined),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: null,
    webhookSecret: null,
    botUsername: null,
  })),
  slackInstallations: {},
  slackUserMappings: {},
  sql: vi.fn(),
  syncSetupQualificationBlock: vi.fn(),
  users: {},
  workItems: {},
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

import { startSetupNewOnboardingTaskCommand } from './onboarding';
import { TaskPayloadKind } from '@roomote/types';
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
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            description: 'kickoff prompt',
            visibleInTranscript: false,
            communicationProvider: 'telegram',
            communicationChannelId: '8846357662',
            communicationMessageId: '900',
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
      expect(enqueueCloudTask).toHaveBeenCalledTimes(1);

      const enqueueInput = vi.mocked(enqueueCloudTask).mock.calls[0]?.[0];
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
      expect(enqueueCloudTask).toHaveBeenCalledTimes(1);

      const enqueueInput = vi.mocked(enqueueCloudTask).mock.calls[0]?.[0];
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

      const enqueueInput = vi.mocked(enqueueCloudTask).mock.calls[0]?.[0];
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

    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
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
    expect(enqueueCloudTask).toHaveBeenCalledWith(
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
    expect(enqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
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
