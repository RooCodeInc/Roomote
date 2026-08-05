import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const replaceMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const removeQueriesMock = vi.fn();
const fetchQueryMock = vi.fn();
const mutationOptionsMock = vi.fn((options) => options);
const mutateMock = vi.fn();
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
    useMutation: (options: { onSuccess?: () => Promise<void> | void }) => ({
      mutate: async (input?: unknown) => {
        mutateMock(input);
        await options.onSuccess?.();
      },
      isPending: false,
    }),
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

import { StepInvoke } from './StepInvoke';

describe('Setup StepInvoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('optimistically completes setup and onboarding before routing away', async () => {
    const onTryItOut = vi.fn();

    render(<StepInvoke onTryItOut={onTryItOut} />);

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    expect(onTryItOut).toHaveBeenCalledTimes(1);
    expect(mutationOptionsMock).toHaveBeenCalled();

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

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

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
    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        anonymousAnalyticsEnabled: true,
        productUpdatesEnabled: false,
      });
    });
  });

  it('routes to the first environment when multiple environments exist', async () => {
    environmentState.environments = [{ id: 'env-newer' }, { id: 'env-older' }];

    render(<StepInvoke />);

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?environmentId=env-newer');
    });
  });

  it('routes to home without an environment param when no environments exist', async () => {
    environmentState.environments = [];

    render(<StepInvoke />);

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

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
    fireEvent.click(
      screen.getByRole('button', { name: /finish environment setup/i }),
    );

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

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/task/task-refreshed');
    });
  });

  it('shows a concrete GitHub comment example', () => {
    render(<StepInvoke sourceControlProviders={['github']} />);

    expect(
      screen.getByText(
        'On a pull request, comment: @roomote address the PR feedback above',
      ),
    ).toBeInTheDocument();
  });

  it('shows a concrete GitLab comment example', () => {
    render(<StepInvoke sourceControlProviders={['gitlab']} />);

    expect(
      screen.getByText(
        'On a merge request, comment: @roomote address the feedback above.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a concrete Bitbucket Cloud comment example', () => {
    render(<StepInvoke sourceControlProviders={['bitbucket']} />);

    expect(
      screen.getByText(
        'On a pull request, comment: @roomote address the feedback above.',
      ),
    ).toBeInTheDocument();
  });

  it('shows configured providers with automations before the web UI', () => {
    render(
      <StepInvoke
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

    render(<StepInvoke />);

    expect(screen.getByText(/^Discord:/)).toBeInTheDocument();
    expect(
      screen.getByText('Try: @roomote Add support for a reset password flow.'),
    ).toBeInTheDocument();
  });
});
