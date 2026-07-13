import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');

  return {
    ...actual,
    useMutation: (options: {
      mutationFn?: (variables: unknown) => unknown;
    }) => ({
      mutateAsync: async (variables: unknown) =>
        options.mutationFn?.(variables),
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
    data: { configured: true, account: null },
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
  Github: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
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

    expect(
      screen.getByText(/Since GitHub is already configured/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect to GitHub/i }));

    expect(createInstallationMutateMock).toHaveBeenCalledWith(
      '/setup?step=source-control-connect',
    );
  });

  it('renders the runtime-configured token-backed sync CTA', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitlab')}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Since GitLab is already configured/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync repositories/i }));

    expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(1);
  });

  it('describes Gitea webhook setup during token-backed onboarding', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('gitea', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/pull request webhooks on the synced repositories/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync repositories/i }));

    expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(1);
    expect(syncRepositoriesOptionsRef.current?.provider).toBe('gitea');
  });

  it('describes Azure DevOps service hook setup during token-backed onboarding', () => {
    render(
      <StepSourceControlConnect
        sourceControlSetup={buildSourceControlSetup('ado', {
          lockReason: null,
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /pull request service hooks on the synced repositories/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sync repositories/i }));

    expect(syncRepositoriesMutateMock).toHaveBeenCalledTimes(1);
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
