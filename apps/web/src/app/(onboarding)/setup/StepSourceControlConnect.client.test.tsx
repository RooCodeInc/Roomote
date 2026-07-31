import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  SetupSourceControlStatus,
  SourceControlProvider,
} from '@roomote/types';

const {
  createInstallationMutateMock,
  syncRepositoriesMutateMock,
  syncRepositoriesOptionsRef,
  ensureQueryDataMock,
  toastErrorMock,
  toastInfoMock,
  toastWarningMock,
  authenticateAdoMutateMock,
  pendingInstallationsDataRef,
  adoLinkedAccountDataRef,
  mutationVariablesRef,
} = vi.hoisted(() => ({
  createInstallationMutateMock: vi.fn(),
  syncRepositoriesMutateMock: vi.fn(),
  syncRepositoriesOptionsRef: {
    current: null as {
      provider: SourceControlProvider;
      options: {
        onSuccess?: (
          data: {
            success: true;
            repositories: unknown[];
            webhooks?: {
              status: 'configured';
              created: number;
              updated: number;
              failed: unknown[];
            };
          },
          variables: void,
          onMutateResult: unknown,
          context: unknown,
        ) => Promise<void>;
      };
    } | null,
  },
  ensureQueryDataMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastInfoMock: vi.fn(),
  toastWarningMock: vi.fn(),
  authenticateAdoMutateMock: vi.fn(),
  pendingInstallationsDataRef: {
    current: undefined as { pending: boolean } | undefined,
  },
  adoLinkedAccountDataRef: {
    current: { configured: true, account: null } as {
      configured: boolean;
      account: { accountId: string; displayName: string } | null;
    },
  },
  mutationVariablesRef: { current: [] as unknown[] },
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');

  return {
    ...actual,
    useMutation: (options: {
      mutationFn?: (variables: unknown) => unknown;
    }) => ({
      mutateAsync: async (variables: unknown) => {
        mutationVariablesRef.current.push(variables);
        return options.mutationFn?.(variables);
      },
      isPending: false,
    }),
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      ensureQueryData: ensureQueryDataMock,
    }),
  };
});

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      status: {
        queryKey: () => ['setupNew.status'],
        queryOptions: () => ({ queryKey: ['setupNew.status'] }),
      },
    },
    sourceControl: {
      saveConfig: {
        mutationOptions: (options: unknown) => options,
      },
      repositories: {
        queryKey: () => ['sourceControl.repositories'],
      },
    },
    linkedAccounts: {
      ado: {
        queryKey: () => ['linkedAccounts.ado'],
        queryOptions: () => ({ queryKey: ['linkedAccounts.ado'] }),
      },
    },
  }),
}));

vi.mock('@/hooks/github/useCreateGitHubInstallation', () => ({
  useCreateGitHubInstallation: () => ({
    mutate: createInstallationMutateMock,
    isPending: false,
  }),
}));

vi.mock('@/hooks/github', () => ({
  useGitHubPendingInstallations: () => ({
    data: pendingInstallationsDataRef.current,
  }),
}));

vi.mock('@/components/github/GitHubInstallRequestPending', () => ({
  GitHubInstallRequestPending: ({ onApproved }: { onApproved: () => void }) => (
    <button type="button" onClick={() => onApproved()}>
      github-install-request-pending
    </button>
  ),
}));

vi.mock('@/hooks/source-control/useSyncRepositories', () => ({
  useSyncRepositories: (
    provider: SourceControlProvider,
    options: NonNullable<typeof syncRepositoriesOptionsRef.current>['options'],
  ) => {
    syncRepositoriesOptionsRef.current = { provider, options };

    return {
      mutate: syncRepositoriesMutateMock,
      isPending: false,
    };
  },
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useAdoLinkedAccount: () => ({
    data: adoLinkedAccountDataRef.current,
    isPending: false,
  }),
  useAuthenticateAdoAccount: () => ({
    mutate: authenticateAdoMutateMock,
    isPending: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: toastInfoMock,
    warning: toastWarningMock,
  },
}));

vi.mock('@/components/system', () => ({
  BrandIcon: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Github: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  RefreshCcw: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { StepSourceControlConnect } from './StepSourceControlConnect';

function buildSourceControlSetup(
  provider: SourceControlProvider,
  overrides: Partial<SetupSourceControlStatus> = {},
): SetupSourceControlStatus {
  return {
    selectedProvider: provider,
    preselectedProvider: provider,
    runtimeConfiguredProvider: provider,
    runtimeConfiguredProviders: [provider],
    lockReason: 'runtime_env',
    connectedProvider: null,
    setupSatisfied: false,
    setupSatisfiedByRuntimeEnv: false,
    providers: [
      {
        provider,
        label:
          provider === 'github'
            ? 'GitHub'
            : provider === 'gitlab'
              ? 'GitLab'
              : provider === 'gitea'
                ? 'Gitea'
                : provider === 'ado'
                  ? 'Azure DevOps'
                  : provider,
        connectionMode: provider === 'github' ? 'app' : 'token',
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
    ...overrides,
  };
}

describe('StepSourceControlConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncRepositoriesOptionsRef.current = null;
    pendingInstallationsDataRef.current = undefined;
    adoLinkedAccountDataRef.current = { configured: true, account: null };
    mutationVariablesRef.current = [];
    ensureQueryDataMock.mockResolvedValue({
      sourceControlSetup: {
        providers: [
          {
            provider: 'gitea',
            connected: true,
          },
        ],
      },
    });
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        pathname: '/setup',
        search: '',
      },
    });
  });

  it('renders the runtime-configured GitHub install CTA', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('github')}
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByText(/Connect to continue/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect to GitHub/i }));

    expect(createInstallationMutateMock).toHaveBeenCalledWith(
      '/setup?step=source-control-connect',
    );
  });

  it('shows the pending-request UI instead of the connect CTA when a GitHub install request is pending', async () => {
    pendingInstallationsDataRef.current = { pending: true };
    const onContinue = vi.fn();

    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('github')}
        onContinue={onContinue}
      />,
    );

    expect(
      screen.getByText(/github-install-request-pending/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect to GitHub/i }),
    ).not.toBeInTheDocument();

    // Approval advances the wizard.
    fireEvent.click(
      screen.getByRole('button', { name: /github-install-request-pending/i }),
    );

    await waitFor(() => expect(onContinue).toHaveBeenCalled());
  });

  it('advances when a pending request transitions to approved without falling back to the connect CTA', async () => {
    pendingInstallationsDataRef.current = { pending: true };
    const onContinue = vi.fn();

    const { rerender } = render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('github')}
        onContinue={onContinue}
      />,
    );

    expect(
      screen.queryByRole('button', { name: /Connect to GitHub/i }),
    ).not.toBeInTheDocument();

    // Polling reports the org owner approved: the shared query flips to
    // pending:false. The step must advance rather than unmount the pending UI
    // and snap back to the connect CTA.
    pendingInstallationsDataRef.current = { pending: false };
    rerender(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('github')}
        onContinue={onContinue}
      />,
    );

    await waitFor(() => expect(onContinue).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: /Connect to GitHub/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the connect CTA when no GitHub install request is pending', () => {
    pendingInstallationsDataRef.current = { pending: false };

    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('github')}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Connect to GitHub/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/github-install-request-pending/i),
    ).not.toBeInTheDocument();
  });

  it('renders the runtime-configured token-backed sync CTA', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitlab')}
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByText(/Connect to continue/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync repositories/i }));

    expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(2);
  });

  it('uses the selected provider copy when a different provider is runtime-configured', () => {
    // GitHub is configured by env vars, but the user chose the unconfigured
    // Gitea. The connect copy must describe Gitea, not claim it is already
    // configured.
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitea', {
          selectedProvider: 'gitea',
          preselectedProvider: 'gitea',
          runtimeConfiguredProvider: 'github',
          runtimeConfiguredProviders: ['github'],
          lockReason: 'runtime_env',
          providers: [
            {
              ...buildSourceControlSetup('gitea').providers[0]!,
              runtimeConfigSatisfied: false,
              savedConfigSatisfied: true,
              configSatisfied: true,
              configStepSatisfied: true,
              configSatisfiedByRuntimeEnv: false,
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Sync your Gitea repositories/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connect to continue/i)).not.toBeInTheDocument();
  });

  it('describes Gitea webhook setup during token-backed onboarding', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitea', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('gitea').providers[0]!,
              runtimeConfigSatisfied: false,
              savedConfigSatisfied: true,
              configSatisfiedByRuntimeEnv: false,
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Sync your Gitea repositories/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync repositories/i }));

    expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(2);
    expect(syncRepositoriesOptionsRef.current?.provider).toBe('gitea');
  });

  it('describes Azure DevOps service hook setup during token-backed onboarding', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('ado', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('ado').providers[0]!,
              runtimeConfigSatisfied: false,
              savedConfigSatisfied: true,
              configSatisfiedByRuntimeEnv: false,
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Sync your Azure DevOps repositories/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync repositories/i }));

    expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(2);
    expect(syncRepositoriesOptionsRef.current?.provider).toBe('ado');
  });

  it('connects a delegated Azure DevOps account before repository sync', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('ado', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('ado').providers[0]!,
              fields: [
                {
                  envVarName: 'ADO_AUTH_MODE',
                  acceptedEnvVarNames: ['ADO_AUTH_MODE'],
                  label: 'Azure DevOps Authentication Mode',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  savedValue: 'delegated',
                  satisfiedByEnvVarName: 'ADO_AUTH_MODE',
                },
              ],
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/before syncing repositories/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect with your Microsoft account/i,
      }),
    );

    expect(authenticateAdoMutateMock).toHaveBeenCalledWith(
      '/setup?step=source-control-connect',
    );
    expect(syncRepositoriesMutateMock).not.toHaveBeenCalled();
  });

  it('saves the linked account and syncs on the first return from the delegated Azure DevOps sign-in', async () => {
    // Returning from Microsoft, `ADO_LINKED_ACCOUNT_ID` is still unsaved, so
    // `configSatisfied` is false while the config step itself has nothing left
    // to collect. Saving that id is this step's job and must not wait on
    // another click, or the completed sign-in reads as not having registered.
    adoLinkedAccountDataRef.current = {
      configured: true,
      account: { accountId: 'ado-account-id', displayName: 'Ada Lovelace' },
    };

    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('ado', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('ado').providers[0]!,
              runtimeConfigSatisfied: false,
              savedConfigSatisfied: false,
              configSatisfied: false,
              configStepSatisfied: true,
              configSatisfiedByRuntimeEnv: false,
              fields: [
                {
                  envVarName: 'ADO_AUTH_MODE',
                  acceptedEnvVarNames: ['ADO_AUTH_MODE'],
                  label: 'Azure DevOps Authentication Mode',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  savedValue: 'delegated',
                  satisfiedByEnvVarName: 'ADO_AUTH_MODE',
                },
              ],
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(1);
    });
    expect(mutationVariablesRef.current).toContainEqual({
      provider: 'ado',
      values: {
        ADO_AUTH_MODE: 'delegated',
        ADO_LINKED_ACCOUNT_ID: 'ado-account-id',
      },
    });
    expect(authenticateAdoMutateMock).not.toHaveBeenCalled();
  });

  it('does not auto-sync an OAuth-configured GitLab provider before OAuth completes', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitlab', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('gitlab').providers[0]!,
              fields: [
                {
                  envVarName: 'GITLAB_CLIENT_ID',
                  acceptedEnvVarNames: ['GITLAB_CLIENT_ID'],
                  label: 'GitLab OAuth Client ID',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  satisfiedByEnvVarName: 'GITLAB_CLIENT_ID',
                },
                {
                  envVarName: 'GITLAB_CLIENT_SECRET',
                  acceptedEnvVarNames: ['GITLAB_CLIENT_SECRET'],
                  label: 'GitLab OAuth Client Secret',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  satisfiedByEnvVarName: 'GITLAB_CLIENT_SECRET',
                },
              ],
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(syncRepositoriesMutateMock).not.toHaveBeenCalled();
  });

  it('auto-syncs OAuth-configured GitLab once the callback marker is present', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, pathname: '/setup', search: '?sync=1' },
    });

    const { rerender } = render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitlab', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('gitlab').providers[0]!,
              fields: [
                {
                  envVarName: 'GITLAB_CLIENT_ID',
                  acceptedEnvVarNames: ['GITLAB_CLIENT_ID'],
                  label: 'GitLab OAuth Client ID',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  satisfiedByEnvVarName: 'GITLAB_CLIENT_ID',
                },
                {
                  envVarName: 'GITLAB_CLIENT_SECRET',
                  acceptedEnvVarNames: ['GITLAB_CLIENT_SECRET'],
                  label: 'GitLab OAuth Client Secret',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  satisfiedByEnvVarName: 'GITLAB_CLIENT_SECRET',
                },
              ],
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    rerender(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitlab', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          providers: [
            {
              ...buildSourceControlSetup('gitlab').providers[0]!,
              fields: [
                {
                  envVarName: 'GITLAB_CLIENT_ID',
                  acceptedEnvVarNames: ['GITLAB_CLIENT_ID'],
                  label: 'GitLab OAuth Client ID',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  satisfiedByEnvVarName: 'GITLAB_CLIENT_ID',
                },
                {
                  envVarName: 'GITLAB_CLIENT_SECRET',
                  acceptedEnvVarNames: ['GITLAB_CLIENT_SECRET'],
                  label: 'GitLab OAuth Client Secret',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  satisfiedByEnvVarName: 'GITLAB_CLIENT_SECRET',
                },
              ],
            },
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(syncRepositoriesMutateMock).toHaveBeenCalledOnce();
  });

  it('continues after Bitbucket OAuth callback sync already connected repositories', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, pathname: '/setup', search: '?sync=1' },
    });
    const onContinue = vi.fn();
    const onRemoveSyncMarker = vi.fn();

    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('bitbucket', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          connectedProvider: 'bitbucket',
          providers: [
            {
              ...buildSourceControlSetup('bitbucket').providers[0]!,
              connected: true,
              repositoryCount: 1,
            },
          ],
        })}
        onContinue={onContinue}
        onRemoveSyncMarker={onRemoveSyncMarker}
      />,
    );

    expect(onContinue).toHaveBeenCalledOnce();
    expect(onRemoveSyncMarker).toHaveBeenCalledOnce();
  });

  it('reports Gitea webhook setup failures as repositories', async () => {
    const onContinue = vi.fn();

    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitea')}
        onContinue={onContinue}
      />,
    );

    await syncRepositoriesOptionsRef.current?.options.onSuccess?.(
      {
        success: true,
        repositories: [],
        webhooks: {
          status: 'configured',
          created: 0,
          updated: 0,
          failed: [{ repositoryFullName: 'acme/backend' }],
        },
      },
      undefined,
      undefined,
      undefined,
    );

    expect(toastWarningMock).toHaveBeenCalledWith(
      'Webhook setup failed on 1 repository. You can retry from Settings after fixing token permissions.',
    );
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
