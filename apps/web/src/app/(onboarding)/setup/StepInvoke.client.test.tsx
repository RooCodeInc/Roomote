import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const replaceMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const removeQueriesMock = vi.fn();
const fetchQueryMock = vi.fn();
const mutationOptionsMock = vi.fn((options) => ({
  ...options,
  __mutationKey: 'complete',
}));
const starterMutationOptionsMock = vi.fn((options) => ({
  ...options,
  __mutationKey: 'starter',
}));
const mutateMock = vi.fn();
const starterMutateMock = vi.fn();
const environmentState = vi.hoisted(() => ({
  environments: [{ id: 'env-1' }],
  commsProviders: [] as Array<{
    id: 'telegram' | 'discord';
    setupSatisfied: boolean;
  }>,
}));
const userState = vi.hoisted(() => ({
  user: null as { cloudEnabled: boolean; isAdmin: boolean } | null,
}));
const starterResultState = vi.hoisted(() => ({
  queue: [] as Array<{
    sessionId: string | null;
    setupCompleted: boolean;
    completionError: string | null;
  }>,
}));
const queryKeys = {
  setupStatus: ['setup.status'],
  onboardingStatus: ['onboarding.status'],
  githubInstallations: ['github.installations'],
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');

  return {
    ...actual,
    useMutation: (options: {
      __mutationKey?: string;
      onSuccess?: (data?: unknown, variables?: unknown) => Promise<void> | void;
      onError?: (error: Error) => void;
    }) => {
      if (options.__mutationKey === 'starter') {
        return {
          mutate: async (input: { selectedStarterTaskIds: string[] }) => {
            starterMutateMock(input);
            const result = starterResultState.queue.shift() ?? {
              sessionId: 'setup-session-1',
              setupCompleted: true,
              completionError: null,
            };
            await options.onSuccess?.(result, input);
          },
          isPending: false,
        };
      }

      return {
        mutate: async (input?: unknown) => {
          mutateMock(input);
          await options.onSuccess?.();
        },
        isPending: false,
      };
    },
    useQuery: () => ({
      data: {
        providers: environmentState.commsProviders,
        invocationIdentities: [
          {
            provider: 'github',
            mentionText: '@roomote',
            examplePrompt: '@roomote address the PR feedback above',
          },
        ],
      },
    }),
    useQueryClient: () => ({
      setQueryData: setQueryDataMock,
      invalidateQueries: invalidateQueriesMock,
      removeQueries: removeQueriesMock,
      fetchQuery: fetchQueryMock,
    }),
  };
});

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      complete: {
        mutationOptions: mutationOptionsMock,
      },
      completeWithStarterTasks: {
        mutationOptions: starterMutationOptionsMock,
      },
      status: {
        queryKey: () => queryKeys.setupStatus,
      },
    },
    setupNew: {
      status: {
        queryOptions: () => ({ queryKey: ['setupNew.status'] }),
      },
    },
    onboarding: {
      status: {
        queryKey: () => queryKeys.onboardingStatus,
      },
    },
    comms: {
      status: {
        queryOptions: () => ({ queryKey: ['comms.status'] }),
      },
    },
    github: {
      installations: {
        queryKey: () => queryKeys.githubInstallations,
      },
    },
    environments: {
      list: {
        queryOptions: () => ({ queryKey: ['environments.list'] }),
      },
    },
  }),
}));

vi.mock('@/hooks/environments/useEnvironments', () => ({
  useEnvironments: () => ({
    data: environmentState.environments,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => userState,
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertCircle: () => <span>AlertCircle</span>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
  AppWindow: () => <span>AppWindow</span>,
  BrandIcon: ({ name }: { name: string }) => (
    <span aria-label={name} data-testid="brand-icon" />
  ),
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & Record<string, unknown>) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      aria-label={String(props['aria-label'] ?? 'checkbox')}
    />
  ),
  Loader2: () => <span>Loader2</span>,
  LinearLogo: () => <span>LinearLogo</span>,
  ArrowRight: () => <span>ArrowRight</span>,
  Zap: () => <span>Zap</span>,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & Record<string, unknown>) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      aria-label={String(props['aria-label'] ?? 'switch')}
    />
  ),
}));

import { SETUP_STARTER_TASKS } from '@/lib/setup-starter-tasks';
import { StepInvoke } from './StepInvoke';

const STARTER_TASK_TITLES = SETUP_STARTER_TASKS.map(
  (starterTask) => starterTask.title,
);

function uncheckAllStarterTasks() {
  for (const title of STARTER_TASK_TITLES) {
    fireEvent.click(screen.getByRole('checkbox', { name: title }));
  }
}

function clickGo() {
  fireEvent.click(screen.getByRole('button', { name: /^go/i }));
}

describe('Setup StepInvoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    );
    invalidateQueriesMock.mockResolvedValue(undefined);
    fetchQueryMock.mockImplementation(
      async (options: { queryKey?: unknown[] }) => {
        const key = options?.queryKey?.[0];
        if (key === 'environments.list') {
          return environmentState.environments;
        }
        return {
          setupNewState: { onboardingTaskId: null },
        };
      },
    );
    environmentState.environments = [{ id: 'env-1' }];
    environmentState.commsProviders = [];
    userState.user = null;
    starterResultState.queue = [];
  });

  it('shows an actionable retry when sandbox provisioning fails', () => {
    const onRetryComputeProvisioning = vi.fn();

    render(
      <StepInvoke
        computeProvisioning={{
          status: 'failed',
          runtimeSchemaVersion: 3,
          imageRef: 'registry.example.com/worker:tag',
          templateRef: null,
          error: 'Access denied',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }}
        onRetryComputeProvisioning={onRetryComputeProvisioning}
      />,
    );

    expect(
      screen.getByText(/Sandbox provider provisioning failed/),
    ).toHaveTextContent('Access denied');
    fireEvent.click(screen.getByRole('button', { name: 'Retry provisioning' }));
    expect(onRetryComputeProvisioning).toHaveBeenCalledOnce();
  });

  it('renders every starter task preselected under the new headline', () => {
    render(<StepInvoke />);

    expect(
      screen.getByText("You're set up. Let's get Roomote working."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Pick a few areas for Roomote to dig into. It will explore your repositories and start the most valuable work it finds:',
      ),
    ).toBeInTheDocument();

    for (const title of STARTER_TASK_TITLES) {
      expect(screen.getByRole('checkbox', { name: title })).toBeChecked();
    }
  });

  it('submits a single selected starter task and routes to the setup session', async () => {
    render(<StepInvoke />);

    for (const title of STARTER_TASK_TITLES.slice(1)) {
      fireEvent.click(screen.getByRole('checkbox', { name: title }));
    }
    clickGo();

    await waitFor(() => {
      expect(starterMutateMock).toHaveBeenCalledWith({
        launchBatchId: '11111111-1111-4111-8111-111111111111',
        selectedStarterTaskIds: ['speed-up-ci'],
        anonymousAnalyticsEnabled: true,
        productUpdatesEnabled: true,
      });
    });

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/sessions/setup-session-1');
    });

    expect(setQueryDataMock).toHaveBeenCalledWith(
      queryKeys.setupStatus,
      expect.any(Function),
    );
    expect(setQueryDataMock).toHaveBeenCalledWith(
      queryKeys.onboardingStatus,
      expect.any(Function),
    );
    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: queryKeys.setupStatus,
      });
    });
    expect(removeQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.githubInstallations,
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('submits the full selection and routes to the one setup session', async () => {
    render(<StepInvoke />);

    clickGo();

    await waitFor(() => {
      expect(starterMutateMock).toHaveBeenCalledWith({
        launchBatchId: '11111111-1111-4111-8111-111111111111',
        selectedStarterTaskIds: [
          'speed-up-ci',
          'security-scan',
          'fix-test-flakes',
          'update-dependencies',
        ],
        anonymousAnalyticsEnabled: true,
        productUpdatesEnabled: true,
      });
    });

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/sessions/setup-session-1');
    });
  });

  it('surfaces a completion error and retries with the same selection', async () => {
    starterResultState.queue.push({
      sessionId: null,
      setupCompleted: false,
      completionError: 'settings write failed',
    });

    render(<StepInvoke />);

    clickGo();

    await waitFor(() => {
      expect(screen.getByText(/settings write failed/)).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(starterMutateMock).toHaveBeenLastCalledWith({
        launchBatchId: '11111111-1111-4111-8111-111111111111',
        selectedStarterTaskIds: [
          'speed-up-ci',
          'security-scan',
          'fix-test-flakes',
          'update-dependencies',
        ],
        anonymousAnalyticsEnabled: true,
        productUpdatesEnabled: true,
      });
    });

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/sessions/setup-session-1');
    });
  });

  it('reuses the launch batch id after an ambiguous result and remount', async () => {
    starterResultState.queue.push({
      sessionId: null,
      setupCompleted: false,
      completionError: 'Request timed out.',
    });

    const firstRender = render(<StepInvoke />);
    clickGo();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /retry/i }),
      ).toBeInTheDocument();
    });
    firstRender.unmount();

    render(<StepInvoke />);
    clickGo();

    await waitFor(() => {
      expect(starterMutateMock).toHaveBeenCalledTimes(2);
    });
    expect(starterMutateMock.mock.calls[0]?.[0].launchBatchId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(starterMutateMock.mock.calls[1]?.[0].launchBatchId).toBe(
      starterMutateMock.mock.calls[0]?.[0].launchBatchId,
    );
  });

  it('optimistically completes setup and onboarding before routing away when nothing is selected', async () => {
    const onTryItOut = vi.fn();

    render(<StepInvoke onTryItOut={onTryItOut} />);

    uncheckAllStarterTasks();
    clickGo();

    expect(onTryItOut).toHaveBeenCalledTimes(1);
    expect(mutationOptionsMock).toHaveBeenCalled();
    expect(starterMutateMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(setQueryDataMock).toHaveBeenCalledWith(
        queryKeys.setupStatus,
        expect.any(Function),
      );
    });

    expect(setQueryDataMock).toHaveBeenCalledWith(
      queryKeys.onboardingStatus,
      expect.any(Function),
    );

    const setupUpdater = setQueryDataMock.mock.calls.find(
      ([queryKey]) => queryKey === queryKeys.setupStatus,
    )?.[1] as
      | ((old: { setupCompletedAt: null; hasGitHub: boolean }) => {
          setupCompletedAt: Date;
          hasGitHub: boolean;
        })
      | undefined;

    const onboardingUpdater = setQueryDataMock.mock.calls.find(
      ([queryKey]) => queryKey === queryKeys.onboardingStatus,
    )?.[1] as
      | ((old: { onboardingCompletedAt: null; orgHasSlack: boolean }) => {
          onboardingCompletedAt: Date;
          orgHasSlack: boolean;
        })
      | undefined;

    expect(
      setupUpdater?.({
        setupCompletedAt: null,
        hasGitHub: true,
      }).setupCompletedAt,
    ).toBeInstanceOf(Date);

    expect(
      onboardingUpdater?.({
        onboardingCompletedAt: null,
        orgHasSlack: true,
      }).onboardingCompletedAt,
    ).toBeInstanceOf(Date);

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: queryKeys.setupStatus,
      });
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.onboardingStatus,
    });

    expect(removeQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.githubInstallations,
    });

    expect(replaceMock).toHaveBeenCalledWith('/?environmentId=env-1');
  });

  it('hides the anonymous analytics opt-out for Roomote Cloud', () => {
    userState.user = { cloudEnabled: true, isAdmin: true };

    render(<StepInvoke />);

    expect(
      screen.queryByRole('checkbox', { name: 'Toggle anonymous analytics' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Toggle product updates' }),
    ).not.toBeInTheDocument();
  });

  it('sends independent enabled preferences by default', async () => {
    render(<StepInvoke />);

    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        anonymousAnalyticsEnabled: true,
        productUpdatesEnabled: true,
      });
    });
  });

  it('lets users opt out of product updates without changing analytics', async () => {
    render(<StepInvoke />);

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Toggle product updates' }),
    );
    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        anonymousAnalyticsEnabled: true,
        productUpdatesEnabled: false,
      });
    });
  });

  it('includes preferences when launching starter tasks', async () => {
    render(<StepInvoke />);

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Toggle product updates' }),
    );
    clickGo();

    await waitFor(() => {
      expect(starterMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          anonymousAnalyticsEnabled: true,
          productUpdatesEnabled: false,
        }),
      );
    });
  });

  it('routes to the first environment when multiple environments exist', async () => {
    environmentState.environments = [{ id: 'env-newer' }, { id: 'env-older' }];

    render(<StepInvoke />);

    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?environmentId=env-newer');
    });
  });

  it('routes to home without an environment param when no environments exist', async () => {
    environmentState.environments = [];

    render(<StepInvoke />);

    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/');
    });
  });

  it('explains the background setup task and finishes onboarding at its canonical task page', async () => {
    render(<StepInvoke onboardingTaskId="task-onboarding-1" />);

    expect(
      screen.getByText(
        /once your environment is configured, you can work with roomote in these ways/i,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/task/task-onboarding-1');
    });
    // Destination is already known from the invoke prop — do not wait on a
    // setupNew.status refresh before leaving, or /setup can flash Home first.
    expect(fetchQueryMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalledWith(
      expect.stringContaining('environmentId='),
    );
    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: queryKeys.setupStatus,
      });
    });
  });

  it('uses the refreshed onboarding task id when finishing setup', async () => {
    fetchQueryMock.mockResolvedValueOnce({
      setupNewState: { onboardingTaskId: 'task-refreshed' },
    });

    render(<StepInvoke />);

    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/task/task-refreshed');
    });
  });

  it('ignores a failed onboarding task id when finishing setup', async () => {
    environmentState.environments = [];
    fetchQueryMock.mockResolvedValueOnce({
      onboardingFailed: true,
      setupNewState: { onboardingTaskId: 'task-failed' },
    });

    render(<StepInvoke />);

    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/');
    });
    expect(replaceMock).not.toHaveBeenCalledWith('/task/task-failed');
  });

  it('shows a concrete GitHub comment example', () => {
    render(
      <StepInvoke
        onboardingTaskId="task-onboarding-1"
        sourceControlProviders={['github']}
      />,
    );

    expect(
      screen.getByText(
        'On a pull request, comment: @roomote address the PR feedback above',
      ),
    ).toBeInTheDocument();
  });

  it('shows a concrete GitLab comment example', () => {
    render(
      <StepInvoke
        onboardingTaskId="task-onboarding-1"
        sourceControlProviders={['gitlab']}
      />,
    );

    expect(
      screen.getByText(
        'On a merge request, comment: @roomote address the feedback above.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a concrete Bitbucket Cloud comment example', () => {
    render(
      <StepInvoke
        onboardingTaskId="task-onboarding-1"
        sourceControlProviders={['bitbucket']}
      />,
    );

    expect(
      screen.getByText(
        'On a pull request, comment: @roomote address the feedback above.',
      ),
    ).toBeInTheDocument();
  });

  it('shows configured providers with automations before the web UI', () => {
    render(
      <StepInvoke
        onboardingTaskId="task-onboarding-1"
        communicationProviders={['telegram']}
        sourceControlProviders={['ado']}
      />,
    );

    expect(screen.getByText(/^Telegram:/)).toBeInTheDocument();
    expect(screen.getByText(/^Azure DevOps:/)).toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();

    const methodHeadings = screen
      .getAllByText(/^(Telegram|Azure DevOps|Automations|Web UI):$/)
      .map((node) => node.textContent?.replace(/:\s*$/, ''));

    expect(methodHeadings).toEqual([
      'Telegram',
      'Azure DevOps',
      'Automations',
      'Web UI',
    ]);
  });

  it('discovers configured Discord and shows a concrete prompt example', () => {
    environmentState.commsProviders = [{ id: 'discord', setupSatisfied: true }];

    render(<StepInvoke onboardingTaskId="task-onboarding-1" />);

    expect(screen.getByText(/^Discord:/)).toBeInTheDocument();
    expect(
      screen.getByText('Try: @roomote Add support for a reset password flow.'),
    ).toBeInTheDocument();
  });

  it('includes the link_suggested param when selected suggested tasks were started', async () => {
    render(<StepInvoke linkSuggestedTasks={true} />);

    uncheckAllStarterTasks();
    clickGo();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        '/?environmentId=env-1&link_suggested=true',
      );
    });
  });
});
