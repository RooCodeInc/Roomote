import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const replaceMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const removeQueriesMock = vi.fn();
const fetchQueryMock = vi.fn();
const mutationOptionsMock = vi.fn((options) => options);
const environmentState = vi.hoisted(() => ({
  environments: [{ id: 'env-1' }],
}));

const queryKeys = {
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
    onboarding: {
      complete: {
        mutationOptions: mutationOptionsMock,
      },
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

vi.mock('../setup/StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../setup/StepCompletedBadge', () => ({
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
  Loader2: () => <span>Loader2</span>,
  LinearLogo: () => <span>LinearLogo</span>,
  ArrowRight: () => <span>ArrowRight</span>,
  Zap: () => <span>Zap</span>,
}));

import { StepInvoke } from './StepInvoke';

describe('Onboarding StepInvoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateQueriesMock.mockResolvedValue(undefined);
    environmentState.environments = [{ id: 'env-1' }];
    fetchQueryMock.mockImplementation(
      async () => environmentState.environments,
    );
  });

  it('optimistically completes onboarding before routing away', async () => {
    render(<StepInvoke />);

    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => {
      expect(setQueryDataMock).toHaveBeenCalledWith(
        queryKeys.onboardingStatus,
        expect.any(Function),
      );
    });

    const onboardingUpdater = setQueryDataMock.mock.calls.find(
      ([queryKey]) => queryKey === queryKeys.onboardingStatus,
    )?.[1] as
      | ((old: { onboardingCompletedAt: null; orgHasSlack: boolean }) => {
          onboardingCompletedAt: Date;
          orgHasSlack: boolean;
        })
      | undefined;

    expect(
      onboardingUpdater?.({
        onboardingCompletedAt: null,
        orgHasSlack: true,
      }).onboardingCompletedAt,
    ).toBeInstanceOf(Date);

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: queryKeys.onboardingStatus,
      });
    });

    expect(removeQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.githubInstallations,
    });

    expect(replaceMock).toHaveBeenCalledWith('/?environmentId=env-1');
  });

  it('routes to the first environment when multiple environments exist', async () => {
    environmentState.environments = [{ id: 'env-newer' }, { id: 'env-older' }];

    render(<StepInvoke />);

    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?environmentId=env-newer');
    });
  });

  it('clarifies that GitHub mentions work on any PR', () => {
    render(<StepInvoke sourceControlProviders={['github']} />);

    expect(
      screen.getByText('Mention @roomote in a comment on any PR.'),
    ).toBeInTheDocument();
  });

  it('shows only configured providers with automations before the web UI', () => {
    render(
      <StepInvoke
        communicationProviders={['microsoft']}
        sourceControlProviders={['gitlab']}
      />,
    );

    expect(screen.getByText('Microsoft Teams')).toBeInTheDocument();
    expect(screen.getByText('GitLab')).toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();

    const methodHeadings = screen
      .getAllByText(/^(Microsoft Teams|GitLab|Automations|Web UI)$/)
      .map((node) => node.textContent);

    expect(methodHeadings).toEqual([
      'Microsoft Teams',
      'GitLab',
      'Automations',
      'Web UI',
    ]);
  });
});
