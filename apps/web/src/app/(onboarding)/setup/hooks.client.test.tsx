import { act, renderHook, waitFor } from '@testing-library/react';
import { useMutation, useQuery } from '@tanstack/react-query';

const { queryOptionsMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn(() => ({
    queryKey: ['setupNew.status'],
    queryFn: vi.fn(),
  })),
}));

const { routerMock } = vi.hoisted(() => ({
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      status: {
        queryOptions: queryOptionsMock,
      },
      ensureDefaultAgents: {
        mutationOptions: () => ({}),
      },
    },
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    user: {
      isAdmin: true,
    },
  }),
}));

const { setupSessionState } = vi.hoisted(() => ({
  setupSessionState: {
    session: {
      onboardingTask: {
        taskId: null as string | null,
        postOnboardingUnlocked: false,
      },
      suggestedTasksStep: {
        state: 'pending' as 'pending' | 'completed' | 'skipped',
      },
      communicationStep: {
        state: 'pending' as 'pending' | 'completed' | 'skipped',
      },
    },
  },
}));

vi.mock('./setup-session', () => ({
  useSetupAsyncSession: () => ({
    hydrated: true,
    session: setupSessionState.session,
    unlockPostOnboardingFlow: () => {
      setupSessionState.session = {
        ...setupSessionState.session,
        onboardingTask: {
          ...setupSessionState.session.onboardingTask,
          postOnboardingUnlocked: true,
        },
      };
    },
    setSuggestedTasksStepState: vi.fn(),
    setCommunicationStepState: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');

  return {
    ...actual,
    useMutation: vi.fn(),
    useQuery: vi.fn(),
  };
});

const mockUseMutation = vi.mocked(useMutation);
const mockUseQuery = vi.mocked(useQuery);

import { useSetupFlow } from './hooks';
import { markSetupWelcomeSeen } from './welcome-seen';

function mockStatus(overrides: Partial<Record<string, unknown>> = {}) {
  mockUseQuery.mockReturnValue({
    data: {
      hasGitHub: false,
      hasSlack: false,
      hasSlackInstallation: false,
      onboardingSucceeded: false,
      onboardingFailed: false,
      onboardingTaskStatus: null,
      onboardingTaskPhase: null,
      setupCompletedAt: null,
      selectedRepositories: [],
      matchingEnvironment: null,
      queuedOnboardingTasks: [],
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: null,
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [],
      },
      modelSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        preselectedProvider: 'openrouter',
      },
      computeSetup: {
        setupSatisfied: true,
        selectedProvider: 'docker',
        preselectedProvider: 'docker',
        runtimeDefaultProvider: null,
        persistedDefaultProvider: 'docker',
        providers: [],
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: null,
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: false,
            configSatisfied: false,
            configStepSatisfied: false,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: null,
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
      ...overrides,
    },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof mockUseQuery>);
}

function trialModelSetup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runtimeRoomoteModel: null,
    runtimeRoomoteModelSatisfied: false,
    runtimeProviderId: 'roomote',
    persistedRoomoteModel: null,
    persistedProviderId: null,
    preselectedProvider: 'roomote',
    setupSatisfied: true,
    setupSatisfiedByRuntimeEnv: true,
    chatgptConnected: false,
    providers: [
      {
        id: 'roomote',
        label: 'Roomote inference',
        // The imported Settings row, not the hosting-injected env variable,
        // is what connects the provider.
        runtimeApiKeySatisfied: false,
        savedApiKeySatisfied: true,
      },
    ],
    ...overrides,
  };
}

function mockReadyForRepository({
  onboardingTaskId = null,
  selectedRepositoryIds = [],
  onboardingFailed = false,
  automationRecommendations,
}: {
  onboardingTaskId?: string | null;
  selectedRepositoryIds?: string[];
  onboardingFailed?: boolean;
  automationRecommendations?: null;
} = {}) {
  setupSessionState.session = {
    ...setupSessionState.session,
    communicationStep: { state: 'skipped' },
  };
  mockStatus({
    onboardingFailed,
    authSetup: {
      setupSatisfiedByRuntimeEnv: true,
      selectedProvider: 'slack',
      preselectedProvider: 'slack',
      runtimeConfiguredProvider: 'slack',
      runtimeConfiguredProviders: ['slack'],
      lockReason: 'runtime_env',
      providers: [
        {
          id: 'slack',
          label: 'Slack',
          fields: [],
          runtimeSatisfied: true,
          savedSatisfied: false,
          setupSatisfied: true,
        },
      ],
    },
    modelSetup: {
      setupSatisfied: true,
      setupSatisfiedByRuntimeEnv: true,
      preselectedProvider: 'openrouter',
    },
    sourceControlSetup: {
      setupSatisfied: true,
      setupSatisfiedByRuntimeEnv: true,
      selectedProvider: 'github',
      preselectedProvider: 'github',
      runtimeConfiguredProvider: 'github',
      runtimeConfiguredProviders: ['github'],
      lockReason: 'runtime_env',
      connectedProvider: 'github',
      providers: [],
    },
    setupNewState: {
      authProvider: 'slack',
      modelProvider: 'openrouter',
      computeProvider: null,
      sourceControlProvider: 'github',
      ...(automationRecommendations === null
        ? { automationRecommendations }
        : { automationRecommendations: { applicationState: 'skipped' } }),
      selectedRepositoryIds,
      onboardingTaskId,
      onboardingTaskStartedAt: onboardingTaskId
        ? '2026-07-10T10:00:00.000Z'
        : null,
      slackChannel: null,
      slackThreadTs: null,
    },
  });
}

function setLocationSearch(search: string) {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search, pathname: '/setup' },
  });
}

describe('useSetupFlow', () => {
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    setLocationSearch('');
    setupSessionState.session = {
      onboardingTask: {
        taskId: null,
        postOnboardingUnlocked: false,
      },
      suggestedTasksStep: {
        state: 'pending',
      },
      communicationStep: {
        state: 'pending',
      },
    };
    mockUseMutation.mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof mockUseMutation>);
    window.history.replaceState = vi.fn();
  });

  afterEach(() => {
    window.history.replaceState = originalReplaceState;
  });

  it('starts with inference setup after email/password auth', async () => {
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('env-vars');
  });

  it('shows the inference choice before provider configuration when trial inference is available', async () => {
    mockStatus({ modelSetup: trialModelSetup() });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToNextStep();
    });

    expect(result.current.step).toBe('inference');
  });

  it('returns from custom provider configuration to the trial choice', async () => {
    markSetupWelcomeSeen();
    mockStatus({ modelSetup: trialModelSetup() });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('inference');
    });

    act(() => {
      result.current.goToStep('env-vars', { revisit: true });
    });
    expect(result.current.step).toBe('env-vars');

    act(() => {
      result.current.goToPreviousStep();
    });
    expect(result.current.step).toBe('inference');
  });

  it('skips custom provider configuration after trial inference is chosen', async () => {
    markSetupWelcomeSeen();
    mockStatus({
      modelSetup: trialModelSetup(),
      setupNewState: {
        authProvider: null,
        modelProvider: 'roomote',
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-provider');
    });
  });

  it('skips the wizard welcome when the bootstrap flow already showed it', async () => {
    // The signed-out bootstrap flow marks the welcome screen as seen when
    // "Get started" is clicked; after account creation the signed-in wizard
    // must not show the same screen again.
    markSetupWelcomeSeen();
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });
  });

  it('still replays the welcome screen on a post-setup revisit even when it was seen before', async () => {
    markSetupWelcomeSeen();
    mockStatus({
      setupCompletedAt: '2024-01-01T00:00:00.000Z',
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });
  });

  it('does not add a sandbox step after source control connects', async () => {
    markSetupWelcomeSeen();
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-provider');

    act(() => {
      result.current.goToStep('source-control-connect');
    });
    expect(result.current.step).toBe('source-control-connect');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-connect');
  });

  it('does not enter a dedicated sandbox step when compute is not configured', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      computeSetup: {
        setupSatisfied: false,
        selectedProvider: null,
        preselectedProvider: 'docker',
        runtimeDefaultProvider: 'docker',
        persistedDefaultProvider: null,
        providers: [],
      },
      sourceControlSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: 'github',
        providers: [],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'github',
        automationRecommendations: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-provider');
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('does not reopen the dedicated sandbox picker when a saved provider is excluded', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      computeSetup: {
        setupSatisfied: true,
        selectedProvider: 'modal',
        preselectedProvider: 'modal',
        runtimeDefaultProvider: 'modal',
        persistedDefaultProvider: null,
        excludedProviders: ['docker'],
        providers: [
          {
            provider: 'modal',
            label: 'Modal',
            description: '',
            supportsSnapshots: true,
            fields: [],
            runtimeConfigSatisfied: true,
            savedConfigSatisfied: false,
            configSatisfied: true,
          },
        ],
      },
      sourceControlSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: 'github',
        providers: [],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: 'docker',
        sourceControlProvider: 'github',
        automationRecommendations: { applicationState: 'skipped' },
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-provider');
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('does not show sandbox configuration in the activation wizard', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      computeSetup: {
        setupSatisfied: false,
        selectedProvider: 'modal',
        preselectedProvider: 'modal',
        runtimeDefaultProvider: 'docker',
        persistedDefaultProvider: null,
        providers: [
          {
            provider: 'modal',
            label: 'Modal',
            description: '',
            supportsSnapshots: true,
            comment: 'Recommended',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: false,
            configSatisfied: false,
          },
        ],
      },
      sourceControlSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: 'github',
        providers: [],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: 'modal',
        sourceControlProvider: 'github',
        automationRecommendations: { applicationState: 'skipped' },
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-provider');
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('does not show sandbox configuration when Local Docker is selected', async () => {
    mockStatus({
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      computeSetup: {
        setupSatisfied: false,
        selectedProvider: 'docker',
        preselectedProvider: 'docker',
        runtimeDefaultProvider: null,
        persistedDefaultProvider: null,
        providers: [
          {
            provider: 'docker',
            label: 'Local Docker',
            description: '',
            supportsSnapshots: false,
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: false,
            configSatisfied: true,
          },
        ],
      },
      sourceControlSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: 'github',
        providers: [],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: 'docker',
        sourceControlProvider: 'github',
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-provider');
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('keeps a deep-linked source-control-config visible so saved credentials can be fixed', async () => {
    mockStatus({
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: true,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: null,
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'github',
        automationRecommendations: { applicationState: 'skipped' },
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-config');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-config');
    });
  });

  it('does not reopen sandbox setup when deep-linked after setup', async () => {
    mockStatus();
    setLocationSearch('?step=compute-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });
  });

  it('keeps a deep-linked source-control-config visible even when earlier steps are pending', async () => {
    mockStatus({
      // Model setup still pending — the config deep link must win over the
      // first-pending-step clamp so callback errors can route back here.
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: true,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: 'github',
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-config');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-config');
    });
  });

  it('keeps the Azure DevOps delegated user on source-control-connect when returning from the Microsoft OAuth round trip', async () => {
    // Delegated ADO only reports configSatisfied once ADO_LINKED_ACCOUNT_ID is
    // saved, and that save happens on the connect step. Returning from Microsoft
    // must not bounce back to the config step, or the round trip looks like it
    // never registered.
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'ado',
        preselectedProvider: 'ado',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'ado',
            label: 'Azure DevOps',
            connectionMode: 'token',
            fields: [
              {
                envVarName: 'ADO_AUTH_MODE',
                label: 'Auth mode',
                savedValue: 'delegated',
                runtimeSatisfied: false,
                savedSatisfied: true,
              },
              {
                envVarName: 'ADO_LINKED_ACCOUNT_ID',
                label: 'Linked account',
                savedValue: '',
                runtimeSatisfied: false,
                savedSatisfied: false,
              },
            ],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: false,
            // The Entra app credentials are saved, so the config step has
            // nothing left to collect; only the connect step's linked-account
            // save is outstanding.
            configSatisfied: false,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'ado',
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-connect');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-connect');
    });
  });

  it('blocks deep-linking ahead to source-control-connect when model setup is still required', async () => {
    mockStatus({
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-connect');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });
    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=env-vars');
  });

  it('blocks deep-linking ahead to source-control-provider when model setup is still required', async () => {
    mockStatus({
      setupNewState: {
        authProvider: 'slack',
        modelProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });
    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=env-vars');
  });

  it('skips configured inference steps when deep-linking to source control', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-connect');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-provider');
    });
  });

  it('lands on source-control-connect when Teams and inference are configured but the connection is pending', async () => {
    mockStatus({
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'microsoft',
        preselectedProvider: 'microsoft',
        runtimeConfiguredProvider: 'microsoft',
        runtimeConfiguredProviders: ['microsoft'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'microsoft',
            label: 'Microsoft Teams',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'gitlab',
        preselectedProvider: 'gitlab',
        runtimeConfiguredProvider: 'gitlab',
        runtimeConfiguredProviders: ['gitlab'],
        lockReason: 'runtime_env',
        connectedProvider: null,
        providers: [
          {
            provider: 'gitlab',
            label: 'GitLab',
            connectionMode: 'token',
            fields: [],
            runtimeConfigSatisfied: true,
            savedConfigSatisfied: false,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: true,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'microsoft',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'gitlab',
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-connect');
    });

    act(() => {
      result.current.goToNextStep();
    });

    expect(result.current.step).toBe('source-control-connect');
  });

  it('skips the communication provider chooser when the session marks communication skipped', async () => {
    markSetupWelcomeSeen();
    setupSessionState.session = {
      ...setupSessionState.session,
      communicationStep: {
        state: 'skipped',
      },
    };
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });
  });

  it('skips the communication provider chooser after Telegram setup completes', async () => {
    markSetupWelcomeSeen();
    setupSessionState.session = {
      ...setupSessionState.session,
      communicationStep: {
        state: 'completed',
      },
    };
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });
  });

  it('does not enter a sandbox step for an old saved repository selection', async () => {
    mockReadyForRepository({ selectedRepositoryIds: ['repo-1'] });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('does not enter a sandbox step while an old onboarding task is pending', async () => {
    mockReadyForRepository({
      selectedRepositoryIds: ['repo-1'],
      onboardingTaskId: 'task-onboarding-1',
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('does not enter a sandbox step after an old onboarding task failed', async () => {
    mockReadyForRepository({
      selectedRepositoryIds: ['repo-1'],
      onboardingTaskId: 'task-failed',
      onboardingFailed: true,
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-config');
    });
  });

  it('resolves obsolete onboarding-agent deep links to the current step', async () => {
    mockReadyForRepository({
      selectedRepositoryIds: ['repo-1'],
      onboardingTaskId: 'task-onboarding-1',
    });
    setLocationSearch('?step=onboarding-agent');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('compute-config');
    });
    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=welcome');
  });

  it('saved-only source-control config still shows the provider chooser', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: false,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: false,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: null,
        preselectedProvider: 'gitlab',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'gitlab',
            label: 'GitLab',
            connectionMode: 'token',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: true,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-provider');
    });
  });

  it('skips env-vars when persisted model setup is satisfied even without runtime env vars', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: false,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: false,
        preselectedProvider: 'openrouter',
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-connect');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-provider');
    });
  });

  it('pushes the next step URL when the user advances with goToNextStep', async () => {
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToNextStep();
    });

    expect(result.current.step).toBe('env-vars');
    expect(routerMock.push).toHaveBeenCalledWith('/setup?step=env-vars');
  });

  it('merges a later URL write into a step navigation the address bar has not committed yet', async () => {
    mockStatus();
    setLocationSearch('?step=welcome');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToStep('env-vars');
    });

    // `router.push` commits asynchronously, so `window.location.search` still
    // describes the previous step while the navigation is in flight.
    const params = result.current.readSetupSearchParams();
    params.set('modelProvider', 'openai');

    act(() => {
      result.current.commitSetupUrl(params);
    });

    expect(routerMock.replace).toHaveBeenLastCalledWith(
      '/setup?step=env-vars&modelProvider=openai',
    );
  });

  it('pushes a direct step URL when goToStep is called', async () => {
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToStep('env-vars');
    });

    expect(result.current.step).toBe('env-vars');
    expect(routerMock.push).toHaveBeenCalledWith('/setup?step=env-vars');
  });

  it('keeps the originating provider picker available after saving its choice', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: false,
            configSatisfied: false,
            configStepSatisfied: false,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'github',
        automationRecommendations: { applicationState: 'skipped' },
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-config');
    });

    act(() => {
      result.current.goToStep('source-control-provider', { revisit: true });
    });
    act(() => {
      result.current.goToStep('source-control-config');
    });

    expect(result.current.canGoBack).toBe(true);

    act(() => {
      result.current.goToPreviousStep();
    });

    expect(result.current.step).toBe('source-control-provider');
    expect(routerMock.push).toHaveBeenLastCalledWith(
      '/setup?step=source-control-provider',
    );
  });

  it('offers the source-control picker from a first-visible connect step', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: 'github',
        runtimeConfiguredProviders: ['github'],
        lockReason: 'runtime_env',
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: true,
            savedConfigSatisfied: false,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: true,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'github',
        automationRecommendations: { applicationState: 'skipped' },
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-connect');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-connect');
    });
    expect(result.current.canGoBack).toBe(true);

    act(() => {
      result.current.goToPreviousStep();
    });

    expect(result.current.step).toBe('source-control-provider');
    expect(routerMock.push).toHaveBeenLastCalledWith(
      '/setup?step=source-control-provider',
    );
  });

  it('uses the visible setup flow when navigating backward', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('welcome');
    });

    act(() => {
      result.current.goToStep('source-control-provider', { revisit: true });
    });

    expect(result.current.canGoBack).toBe(false);

    act(() => {
      result.current.goToPreviousStep();
    });

    expect(result.current.step).toBe('source-control-provider');
    expect(routerMock.push).toHaveBeenLastCalledWith(
      '/setup?step=source-control-provider',
    );
  });

  it('skips configured steps when going back from a later step', async () => {
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: 'github',
        runtimeConfiguredProviders: ['github'],
        lockReason: 'runtime_env',
        connectedProvider: 'github',
        providers: [],
      },
      computeSetup: {
        setupSatisfied: false,
        selectedProvider: null,
        preselectedProvider: 'docker',
        runtimeDefaultProvider: null,
        persistedDefaultProvider: null,
        providers: [],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'github',
        automationRecommendations: { applicationState: 'skipped' },
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToStep('compute-provider');
    });

    expect(result.current.canGoBack).toBe(false);
    expect(result.current.step).toBe('welcome');
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('uses the same skip-aware sequence going forward and backward', async () => {
    mockStatus({
      hasSlack: false,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: false,
            savedSatisfied: false,
            setupSatisfied: false,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: null,
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: false,
            configSatisfied: false,
            configStepSatisfied: false,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-provider');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-connect');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-connect');

    act(() => {
      result.current.goToPreviousStep();
    });
    expect(result.current.step).toBe('source-control-provider');

    act(() => {
      result.current.goToPreviousStep();
    });
    expect(result.current.step).toBe('env-vars');
  });

  it('does not reopen skipped communication when going back', async () => {
    setupSessionState.session = {
      ...setupSessionState.session,
      communicationStep: { state: 'skipped' },
    };
    mockStatus({
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        preselectedProvider: 'openrouter',
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    act(() => {
      result.current.goToStep('source-control-provider', { revisit: true });
    });

    act(() => {
      result.current.goToPreviousStep();
    });

    expect(result.current.step).toBe('env-vars');
    expect(result.current.step).not.toBe('slack');
  });

  it('redirects a sandbox deep link into the active setup flow', async () => {
    mockStatus();
    setLocationSearch('?step=compute-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=welcome');
  });

  it('keeps source-control-provider after goToStep when a provider is already saved', async () => {
    mockStatus({
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: true,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: null,
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: 'github',
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result, rerender } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).not.toBe('welcome');
    });

    act(() => {
      result.current.goToStep('source-control-provider', { revisit: true });
    });

    expect(result.current.step).toBe('source-control-provider');
    expect(routerMock.push).toHaveBeenCalledWith(
      '/setup?step=source-control-provider',
    );

    // A status refresh that still treats the picker as skippable must not
    // auto-advance while the user is intentionally reviewing their choice.
    act(() => {
      mockStatus({
        sourceControlSetup: {
          setupSatisfied: false,
          setupSatisfiedByRuntimeEnv: false,
          selectedProvider: 'github',
          preselectedProvider: 'github',
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          lockReason: null,
          connectedProvider: null,
          providers: [
            {
              provider: 'github',
              label: 'GitHub',
              connectionMode: 'app',
              fields: [],
              runtimeConfigSatisfied: false,
              savedConfigSatisfied: true,
              configSatisfied: true,
              configStepSatisfied: true,
              configSatisfiedByRuntimeEnv: false,
              connected: false,
              repositoryCount: 0,
            },
          ],
        },
        setupNewState: {
          authProvider: null,
          modelProvider: null,
          computeProvider: null,
          sourceControlProvider: 'github',
          selectedRepositoryIds: [],
          onboardingTaskId: null,
          onboardingTaskStartedAt: null,
          slackChannel: null,
          slackThreadTs: null,
        },
      });
      rerender();
    });

    expect(result.current.step).toBe('source-control-provider');
  });

  it('resolves a removed slack deep link to the current pending step', async () => {
    mockStatus({
      hasSlack: true,
      hasSlackInstallation: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: false,
            savedSatisfied: true,
            setupSatisfied: true,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=slack');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=env-vars');
  });

  it('strips transient callback params but preserves the step in the URL', async () => {
    mockStatus();
    setLocationSearch('?step=env-vars&openrouter=connected');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    expect(window.history.replaceState).toHaveBeenCalledWith(
      {},
      '',
      '/setup?step=env-vars',
    );
  });

  it('preserves a valid current step deep link without replacing it', async () => {
    mockStatus({
      authSetup: {
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: false,
            savedSatisfied: false,
            setupSatisfied: false,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: null,
        computeProvider: null,
        sourceControlProvider: null,
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=env-vars');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?step=env-vars');
  });

  it('updates the active step when the URL changes via browser back/forward', async () => {
    mockStatus();
    setLocationSearch('?step=compute-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      setLocationSearch('?step=env-vars');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });
  });

  it('keeps a satisfied pinnable step when browser history lands on it', async () => {
    // Progress past auth + inference so the first pending step is connect;
    // history back to the already-chosen picker should pin in-range.
    mockStatus({
      hasSlack: true,
      authSetup: {
        setupSatisfiedByRuntimeEnv: true,
        selectedProvider: 'slack',
        preselectedProvider: 'slack',
        runtimeConfiguredProvider: 'slack',
        runtimeConfiguredProviders: ['slack'],
        lockReason: 'runtime_env',
        providers: [
          {
            id: 'slack',
            label: 'Slack',
            fields: [],
            runtimeSatisfied: true,
            savedSatisfied: false,
            setupSatisfied: true,
          },
        ],
      },
      modelSetup: {
        setupSatisfied: true,
        setupSatisfiedByRuntimeEnv: true,
        preselectedProvider: 'openrouter',
      },
      sourceControlSetup: {
        setupSatisfied: false,
        setupSatisfiedByRuntimeEnv: false,
        selectedProvider: 'github',
        preselectedProvider: 'github',
        runtimeConfiguredProvider: null,
        runtimeConfiguredProviders: [],
        lockReason: null,
        connectedProvider: null,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: false,
            savedConfigSatisfied: true,
            configSatisfied: true,
            configStepSatisfied: true,
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: 'slack',
        modelProvider: 'openrouter',
        computeProvider: null,
        sourceControlProvider: 'github',
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });
    setLocationSearch('?step=source-control-config');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-config');
    });

    act(() => {
      setLocationSearch('?step=source-control-provider');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => {
      expect(result.current.step).toBe('source-control-provider');
    });
  });

  it('replaces the URL when an auto-skip correction fires after a deferred status load', async () => {
    // Start in the loading state so the init effect runs after mount and the
    // initial resolved step is the no-op default `welcome`.
    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof mockUseQuery>);

    const { result, rerender } = renderHook(() => useSetupFlow());

    expect(result.current.step).toBe('welcome');

    // Status arrives and resolves to the default welcome step (a no-op update).
    act(() => {
      mockStatus();
      rerender();
    });

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    routerMock.replace.mockClear();

    // A later status refresh makes welcome impossible; the auto-skip watchdog
    // advances the step and the URL must be replaced to match.
    act(() => {
      mockStatus({
        setupNewState: {
          authProvider: 'slack',
          modelProvider: null,
          sourceControlProvider: null,
          selectedRepositoryIds: [],
          onboardingTaskId: null,
          onboardingTaskStartedAt: null,
          slackChannel: null,
          slackThreadTs: null,
        },
      });
      rerender();
    });

    await waitFor(() => {
      expect(result.current.step).toBe('env-vars');
    });

    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=env-vars');
  });
});
