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
            configSatisfiedByRuntimeEnv: false,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupQualification: {
        activeBlock: null,
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

function mockReadyForRepository({
  onboardingTaskId = null,
  selectedRepositoryIds = [],
  onboardingFailed = false,
}: {
  onboardingTaskId?: string | null;
  selectedRepositoryIds?: string[];
  onboardingFailed?: boolean;
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

  it('starts with auth-provider when auth selection is still missing', async () => {
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('auth-provider');
  });

  it('skips the wizard welcome when the bootstrap flow already showed it', async () => {
    // The signed-out bootstrap flow marks the welcome screen as seen when
    // "Get started" is clicked; after account creation the signed-in wizard
    // must not show the same screen again.
    markSetupWelcomeSeen();
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('auth-provider');
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

  it('puts communication connection between auth config and model setup', async () => {
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
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('auth-env-vars');
    });

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('slack');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('env-vars');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-provider');
  });

  it('shows compute-provider after source control when compute setup is pending', async () => {
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
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('compute-provider');
    });
  });

  it('shows compute-config when a compute provider is chosen but not yet configured', async () => {
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
        selectedRepositoryIds: [],
        onboardingTaskId: null,
        onboardingTaskStartedAt: null,
        slackChannel: null,
        slackThreadTs: null,
      },
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('compute-config');
    });
  });

  it('skips compute-config when Local Docker is chosen because it has no credentials', async () => {
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
      expect(result.current.step).toBe('slack');
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

  it('reopens the compute provider picker when deep-linked after setup', async () => {
    // Base mock: compute setup satisfied with docker chosen — normally the
    // step is skipped, but the explicit link reopens it to switch providers.
    mockStatus();
    setLocationSearch('?step=compute-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('compute-provider');
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
      expect(result.current.step).toBe('auth-env-vars');
    });
    expect(routerMock.replace).toHaveBeenCalledWith(
      '/setup?step=auth-env-vars',
    );
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
      expect(result.current.step).toBe('auth-env-vars');
    });
    expect(routerMock.replace).toHaveBeenCalledWith(
      '/setup?step=auth-env-vars',
    );
  });

  it('skips auth-env-vars and env-vars when runtime auth and model setup are already satisfied', async () => {
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
        authProvider: null,
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

  it('finishes connecting Teams before source control', async () => {
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
            configSatisfiedByRuntimeEnv: true,
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
      setupNewState: {
        authProvider: null,
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
      expect(result.current.step).toBe('slack');
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

  it('skips the communication connect step when the session marks it skipped', async () => {
    setupSessionState.session = {
      ...setupSessionState.session,
      communicationStep: {
        state: 'skipped',
      },
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
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: true,
            savedConfigSatisfied: false,
            configSatisfied: true,
            configSatisfiedByRuntimeEnv: true,
            connected: true,
            repositoryCount: 1,
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

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('repo-selection');
    });
  });

  it('keeps the user on invoke after skipping repo selection with no onboarding task yet', async () => {
    // Skipping environment setup from repo selection before any onboarding
    // task has started must land on invoke and stay there. Previously the
    // auto-skip watchdog treated invoke as unreachable (no onboardingTaskId
    // to scope the unlock to) and yanked the user back to repo selection.
    setupSessionState.session = {
      ...setupSessionState.session,
      communicationStep: {
        state: 'skipped',
      },
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
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connectionMode: 'app',
            fields: [],
            runtimeConfigSatisfied: true,
            savedConfigSatisfied: false,
            configSatisfied: true,
            configSatisfiedByRuntimeEnv: true,
            connected: true,
            repositoryCount: 1,
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

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('repo-selection');
    });

    act(() => {
      result.current.setupSession.unlockPostOnboardingFlow();
      result.current.goToNextPostOnboardingStep(true);
    });

    await waitFor(() => {
      expect(result.current.step).toBe('invoke');
    });

    // Give the auto-skip watchdog a chance to run after the navigation; it
    // must not bounce the user back into repo selection.
    await waitFor(() => {
      expect(result.current.step).toBe('invoke');
    });
  });

  it('keeps a saved selection without a task recoverable at repository selection', async () => {
    mockReadyForRepository({ selectedRepositoryIds: ['repo-1'] });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('repo-selection');
    });
  });

  it('advances a persisted onboarding task to invoke before the environment exists', async () => {
    mockReadyForRepository({
      selectedRepositoryIds: ['repo-1'],
      onboardingTaskId: 'task-onboarding-1',
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('invoke');
    });
  });

  it('returns a failed onboarding task to repository selection', async () => {
    mockReadyForRepository({
      selectedRepositoryIds: ['repo-1'],
      onboardingTaskId: 'task-failed',
      onboardingFailed: true,
    });

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('repo-selection');
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
      expect(result.current.step).toBe('invoke');
    });
    expect(routerMock.replace).toHaveBeenCalledWith('/setup?step=invoke');
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

    expect(result.current.step).toBe('auth-provider');
    expect(routerMock.push).toHaveBeenCalledWith('/setup?step=auth-provider');
  });

  it('pushes a direct step URL when goToStep is called', async () => {
    mockStatus();

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('welcome');
    });

    act(() => {
      result.current.goToStep('auth-env-vars');
    });

    expect(result.current.step).toBe('auth-env-vars');
    expect(routerMock.push).toHaveBeenCalledWith('/setup?step=auth-env-vars');
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
      result.current.goToStep('compute-provider');
    });

    expect(result.current.canGoBack).toBe(false);

    act(() => {
      result.current.goToStep('repo-selection');
    });

    expect(result.current.canGoBack).toBe(true);

    act(() => {
      result.current.goToPreviousStep();
    });

    expect(result.current.step).toBe('compute-provider');
    expect(routerMock.push).toHaveBeenLastCalledWith(
      '/setup?step=compute-provider',
    );
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
      expect(result.current.step).toBe('auth-env-vars');
    });

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('slack');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('env-vars');

    act(() => {
      result.current.goToNextStep();
    });
    expect(result.current.step).toBe('source-control-provider');

    act(() => {
      result.current.goToPreviousStep();
    });
    expect(result.current.step).toBe('env-vars');

    act(() => {
      result.current.goToPreviousStep();
    });
    expect(result.current.step).toBe('slack');

    act(() => {
      result.current.goToPreviousStep();
    });
    expect(result.current.step).toBe('auth-env-vars');
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

  it('keeps a revisitable deep link visible and preserves the step in the URL', async () => {
    // Base mock: compute setup satisfied with docker chosen — the explicit
    // revisitable link reopens the picker and the URL keeps the step.
    mockStatus();
    setLocationSearch('?step=compute-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('compute-provider');
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?step=compute-provider');
  });

  it('keeps auth-provider visible after a choice was already saved', async () => {
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
    setLocationSearch('?step=auth-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('auth-provider');
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?step=auth-provider');
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

  it('keeps messaging connect step when deep-linking after Slack is already connected', async () => {
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
      expect(result.current.step).toBe('slack');
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('strips transient callback params but preserves the step in the URL', async () => {
    mockStatus();
    setLocationSearch('?step=compute-provider&openrouter=connected');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('compute-provider');
    });

    expect(window.history.replaceState).toHaveBeenCalledWith(
      {},
      '',
      '/setup?step=compute-provider',
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
    setLocationSearch('?step=auth-env-vars');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('auth-env-vars');
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?step=auth-env-vars');
  });

  it('updates the active step when the URL changes via browser back/forward', async () => {
    mockStatus();
    setLocationSearch('?step=compute-provider');

    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => {
      expect(result.current.step).toBe('compute-provider');
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
      expect(result.current.step).toBe('auth-env-vars');
    });

    expect(routerMock.replace).toHaveBeenCalledWith(
      '/setup?step=auth-env-vars',
    );
  });
});
