import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const replaceMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const removeQueriesMock = vi.fn();
const mutationOptionsMock = vi.fn((options) => options);
const environmentState = vi.hoisted(() => ({
  environments: [{ id: 'env-1' }],
  commsProviders: [] as Array<{
    id: 'telegram' | 'discord';
    setupSatisfied: boolean;
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
    useMutation: (options: { onSuccess?: () => Promise<void> | void }) => ({
      mutate: async () => {
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
  }),
}));

vi.mock('@/hooks/environments/useEnvironments', () => ({
  useEnvironments: () => ({
    data: environmentState.environments,
  }),
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('./StepCompletedBadge', () => ({
  StepCompletedBadge: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('@/components/system', () => ({
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
  CornerDownRight: () => <span>CornerDownRight</span>,
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
    environmentState.environments = [{ id: 'env-1' }];
    environmentState.commsProviders = [];
  });

  it('optimistically completes setup and onboarding before routing away', async () => {
    const onTryItOut = vi.fn();

    render(<StepInvoke onTryItOut={onTryItOut} />);

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    expect(onTryItOut).toHaveBeenCalledTimes(1);

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

  it('clarifies that GitHub mentions work on any PR', () => {
    render(<StepInvoke sourceControlProviders={['github']} />);

    expect(
      screen.getByText('Mention @roomote in a comment on any PR.'),
    ).toBeInTheDocument();

    expect(
      screen.getByText('@roomote address the PR feedback above'),
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

  it('discovers configured Discord and explains task threads', () => {
    environmentState.commsProviders = [{ id: 'discord', setupSatisfied: true }];

    render(<StepInvoke />);

    expect(screen.getByText(/^Discord:/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'mention it in a server channel, use /new, or continue work in a task thread.',
      ),
    ).toBeInTheDocument();
  });

  it('includes the link_suggested param when selected suggested tasks were started', async () => {
    render(<StepInvoke linkSuggestedTasks={true} />);

    fireEvent.click(screen.getByRole('button', { name: /let'?s go/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        '/?environmentId=env-1&link_suggested=true',
      );
    });
  });
});
