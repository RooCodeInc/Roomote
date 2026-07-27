import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const replaceMock = vi.fn();
const setQueryDataMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const removeQueriesMock = vi.fn();
const mutationOptionsMock = vi.fn((options) => options);
const mutateMock = vi.fn();
const userState = vi.hoisted(() => ({
  user: null as { cloudEnabled: boolean; isAdmin: boolean } | null,
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
    useQuery: () => ({
      data: {
        invocationIdentities: [
          {
            provider: 'github',
            examplePrompt: '@roomote-app address the PR feedback above',
          },
        ],
      },
    }),
    useMutation: (options: { onSuccess?: () => Promise<void> | void }) => ({
      mutate: async (input?: unknown) => {
        mutateMock(input);
        await options.onSuccess?.();
      },
      isPending: false,
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
    onboarding: {
      complete: {
        mutationOptions: mutationOptionsMock,
      },
      status: {
        queryKey: () => queryKeys.onboardingStatus,
      },
    },
    github: {
      installations: {
        queryKey: () => queryKeys.githubInstallations,
      },
    },
    comms: {
      status: {
        queryOptions: vi.fn(() => ({ queryKey: ['comms.status'] })),
      },
    },
  }),
}));

vi.mock('../setup/StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => userState,
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
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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
    userState.user = null;
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

    expect(replaceMock).toHaveBeenCalledWith('/');
  });

  it('submits product updates as enabled by default', async () => {
    render(<StepInvoke />);

    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({ productUpdatesEnabled: true });
    });
  });

  it('keeps the preference independent when users opt out', async () => {
    render(<StepInvoke />);

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Toggle product updates' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        productUpdatesEnabled: false,
      });
    });
  });

  it('hides product updates for Roomote Cloud admins', () => {
    userState.user = { cloudEnabled: true, isAdmin: true };

    render(<StepInvoke />);

    expect(
      screen.queryByRole('checkbox', { name: 'Toggle product updates' }),
    ).not.toBeInTheDocument();
  });

  it('uses the configured GitHub app identity in its invocation example', () => {
    render(<StepInvoke sourceControlProviders={['github']} />);

    expect(
      screen.getByText(
        'On a pull request, comment: @roomote-app address the PR feedback above',
      ),
    ).toBeInTheDocument();
  });

  it('shows only configured providers with automations before the web UI', () => {
    render(
      <StepInvoke
        communicationProviders={['microsoft']}
        sourceControlProviders={['gitlab']}
      />,
    );

    expect(
      screen.getByText('Microsoft Teams:', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText('GitLab:', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();

    const methodHeadings = screen
      .getAllByText(/^(Microsoft Teams|GitLab|Automations|Web UI):$/)
      .map((node) => node.textContent);

    expect(methodHeadings).toEqual([
      'Microsoft Teams: ',
      'GitLab: ',
      'Automations: ',
      'Web UI: ',
    ]);
  });

  it('lists every configured communication and source-control provider without Linear', () => {
    render(
      <StepInvoke
        communicationProviders={['slack', 'microsoft', 'telegram', 'discord']}
        sourceControlProviders={[
          'github',
          'gitlab',
          'gitea',
          'bitbucket',
          'ado',
        ]}
        includeAutomations={false}
      />,
    );

    for (const provider of [
      'Slack',
      'Microsoft Teams',
      'Telegram',
      'Discord',
      'GitHub',
      'GitLab',
      'Gitea',
      'Bitbucket Cloud',
      'Azure DevOps',
    ]) {
      expect(
        screen.getByText(`${provider}:`, { exact: false }),
      ).toBeInTheDocument();
    }

    expect(screen.queryByText('Linear')).not.toBeInTheDocument();
  });
});
