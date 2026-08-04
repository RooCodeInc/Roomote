import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG,
  type SetupSourceControlStatus,
} from '@roomote/types';

const {
  saveMutateMock,
  clearMutateMock,
  saveMutationOptionsRef,
  clearMutationOptionsRef,
  invalidateQueriesMock,
} = vi.hoisted(() => ({
  saveMutateMock: vi.fn(),
  clearMutateMock: vi.fn(),
  saveMutationOptionsRef: {
    current: null as {
      onSuccess?: () => Promise<void> | void;
      onError?: (error: Error) => void;
    } | null,
  },
  clearMutationOptionsRef: {
    current: null as {
      onSuccess?: () => Promise<void> | void;
      onError?: (error: Error) => void;
    } | null,
  },
  invalidateQueriesMock: vi.fn(async () => undefined),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: (
    options:
      | (NonNullable<typeof saveMutationOptionsRef.current> & {
          mutationKey?: string[];
        })
      | null,
  ) => {
    const isClear = options?.mutationKey?.[0] === 'clearConfig';
    if (isClear) {
      clearMutationOptionsRef.current = options;
    } else {
      saveMutationOptionsRef.current = options;
    }
    return {
      mutate: isClear ? clearMutateMock : saveMutateMock,
      isPending: false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { adoLinkedAccountRef } = vi.hoisted(() => ({
  adoLinkedAccountRef: {
    current: {
      data: undefined as
        | {
            configured: boolean;
            account: { accountId: string; displayName: string } | null;
          }
        | undefined,
      isPending: false,
    },
  },
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useAdoLinkedAccount: () => adoLinkedAccountRef.current,
  useAuthenticateAdoAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sourceControl: {
      saveConfig: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationKey: ['saveConfig'],
        }),
      },
      clearGitHubConfig: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationKey: ['clearConfig'],
        }),
      },
      configStatus: {
        queryKey: () => ['sourceControl.configStatus'],
      },
      repositories: {
        queryKey: () => ['sourceControl.repositories'],
      },
    },
    github: {
      installations: {
        queryKey: () => ['github.installations'],
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

import { SourceControlConfigForm } from './SourceControlConfigForm';

const MASKED_VALUE = '••••••••••••••••••••••••••••';

function buildConfigStatus(
  fields: SetupSourceControlStatus['providers'][number]['fields'],
): SetupSourceControlStatus {
  return {
    selectedProvider: 'github',
    preselectedProvider: 'github',
    runtimeConfiguredProvider: null,
    runtimeConfiguredProviders: [],
    lockReason: null,
    connectedProvider: 'github',
    setupSatisfied: true,
    setupSatisfiedByRuntimeEnv: false,
    providers: [
      {
        provider: 'github',
        label: 'GitHub',
        connectionMode: 'app',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: true,
        configSatisfied: true,
        configStepSatisfied: true,
        configSatisfiedByRuntimeEnv: false,
        connected: true,
        repositoryCount: 2,
        fields,
      },
    ],
  };
}

function buildUnconfiguredProviderStatus(
  provider: Exclude<SetupSourceControlStatus['preselectedProvider'], 'github'>,
): SetupSourceControlStatus {
  const catalogProvider = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
    (candidate) => candidate.provider === provider,
  )!;

  return {
    selectedProvider: provider,
    preselectedProvider: provider,
    runtimeConfiguredProvider: null,
    runtimeConfiguredProviders: [],
    lockReason: null,
    connectedProvider: null,
    setupSatisfied: false,
    setupSatisfiedByRuntimeEnv: false,
    providers: [
      {
        ...catalogProvider,
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        configStepSatisfied: false,
        configSatisfiedByRuntimeEnv: false,
        connected: false,
        repositoryCount: 0,
        fields: catalogProvider.fields.map((field) => ({
          ...field,
          runtimeSatisfied: false,
          savedSatisfied: false,
          savedValue: null,
          satisfiedByEnvVarName: null,
        })),
      },
    ],
  };
}

describe('SourceControlConfigForm', () => {
  beforeEach(() => {
    saveMutateMock.mockReset();
    clearMutateMock.mockReset();
    invalidateQueriesMock.mockClear();
    saveMutationOptionsRef.current = null;
    clearMutationOptionsRef.current = null;
    adoLinkedAccountRef.current = { data: undefined, isPending: false };
  });

  it('shows plain values for non-secrets and a mask for secrets when runtime-configured', () => {
    render(
      <SourceControlConfigForm
        provider="github"
        configStatus={buildConfigStatus([
          {
            envVarName: 'R_GITHUB_APP_SLUG',
            acceptedEnvVarNames: ['R_GITHUB_APP_SLUG'],
            label: 'GitHub App Slug',
            runtimeSatisfied: true,
            savedSatisfied: false,
            savedValue: 'roomote-app',
            satisfiedByEnvVarName: 'R_GITHUB_APP_SLUG',
          },
          {
            envVarName: 'R_GITHUB_APP_ID',
            acceptedEnvVarNames: ['R_GITHUB_APP_ID'],
            label: 'GitHub App ID',
            runtimeSatisfied: true,
            savedSatisfied: false,
            savedValue: '12345',
            satisfiedByEnvVarName: 'R_GITHUB_APP_ID',
          },
          {
            envVarName: 'R_GITHUB_APP_PRIVATE_KEY',
            acceptedEnvVarNames: ['R_GITHUB_APP_PRIVATE_KEY'],
            label: 'GitHub App Private Key',
            secret: true,
            runtimeSatisfied: true,
            savedSatisfied: false,
            savedValue: null,
            satisfiedByEnvVarName: 'R_GITHUB_APP_PRIVATE_KEY',
          },
        ])}
      />,
    );

    expect(screen.getByDisplayValue('roomote-app')).toBeDisabled();
    expect(screen.getByDisplayValue('12345')).toBeDisabled();
    expect(screen.getByDisplayValue(MASKED_VALUE)).toBeDisabled();
  });

  it('shows saved non-secret values and masks saved secrets when not runtime-configured', () => {
    render(
      <SourceControlConfigForm
        provider="github"
        configStatus={buildConfigStatus([
          {
            envVarName: 'R_GITHUB_APP_SLUG',
            acceptedEnvVarNames: ['R_GITHUB_APP_SLUG'],
            label: 'GitHub App Slug',
            runtimeSatisfied: false,
            savedSatisfied: true,
            savedValue: 'saved-slug',
            satisfiedByEnvVarName: 'R_GITHUB_APP_SLUG',
          },
          {
            envVarName: 'R_GITHUB_CLIENT_SECRET',
            acceptedEnvVarNames: ['R_GITHUB_CLIENT_SECRET'],
            label: 'GitHub OAuth Client Secret',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: true,
            savedValue: null,
            satisfiedByEnvVarName: 'R_GITHUB_CLIENT_SECRET',
          },
        ])}
      />,
    );

    expect(screen.getByDisplayValue('saved-slug')).not.toBeDisabled();
    expect(screen.getByDisplayValue(MASKED_VALUE)).not.toBeDisabled();
  });

  it('clears plaintext secrets after a successful secret-only save', async () => {
    const fields = [
      {
        envVarName: 'R_GITHUB_APP_SLUG',
        acceptedEnvVarNames: ['R_GITHUB_APP_SLUG'],
        label: 'GitHub App Slug',
        runtimeSatisfied: false,
        savedSatisfied: true,
        savedValue: 'saved-slug',
        satisfiedByEnvVarName: 'R_GITHUB_APP_SLUG',
      },
      {
        envVarName: 'R_GITHUB_CLIENT_SECRET',
        acceptedEnvVarNames: ['R_GITHUB_CLIENT_SECRET'],
        label: 'GitHub OAuth Client Secret',
        secret: true as const,
        runtimeSatisfied: false,
        savedSatisfied: true,
        savedValue: null,
        satisfiedByEnvVarName: 'R_GITHUB_CLIENT_SECRET',
      },
    ];

    render(
      <SourceControlConfigForm
        provider="github"
        configStatus={buildConfigStatus(fields)}
      />,
    );

    const secretInput = screen.getByDisplayValue(MASKED_VALUE);
    fireEvent.focus(secretInput);
    fireEvent.change(secretInput, {
      target: { value: 'new-secret-value' },
    });
    expect(screen.getByDisplayValue('new-secret-value')).toBeInTheDocument();
    expect(screen.getByDisplayValue('saved-slug')).toBeInTheDocument();

    await act(async () => {
      await saveMutationOptionsRef.current?.onSuccess?.();
    });

    await waitFor(() => {
      expect(screen.queryByDisplayValue('new-secret-value')).toBeNull();
      expect(screen.getByDisplayValue(MASKED_VALUE)).toBeInTheDocument();
      expect(screen.getByDisplayValue('saved-slug')).toBeInTheDocument();
    });
  });

  it('removes saved GitHub configuration after confirmation', async () => {
    render(
      <SourceControlConfigForm
        provider="github"
        configStatus={buildConfigStatus([
          {
            envVarName: 'R_GITHUB_APP_SLUG',
            acceptedEnvVarNames: ['R_GITHUB_APP_SLUG'],
            label: 'GitHub App Slug',
            runtimeSatisfied: false,
            savedSatisfied: true,
            savedValue: 'deleted-app',
            satisfiedByEnvVarName: 'R_GITHUB_APP_SLUG',
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(
      screen.getByRole('heading', {
        name: 'Remove GitHub configuration?',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/repositories will be disconnected/),
    ).toBeInTheDocument();

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons.at(-1)!);

    expect(clearMutateMock).toHaveBeenCalledWith();

    await act(async () => {
      await clearMutationOptionsRef.current?.onSuccess?.();
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['github.installations'],
    });
  });

  it('renders the Azure DevOps auth modes and advanced fields', () => {
    const ado = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
      (provider) => provider.provider === 'ado',
    )!;
    const fields = ado.fields.map((field) => ({
      ...field,
      runtimeSatisfied: false,
      savedSatisfied: false,
      savedValue: null,
      satisfiedByEnvVarName: null,
    }));

    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={{
          selectedProvider: 'ado',
          preselectedProvider: 'ado',
          runtimeConfiguredProvider: null,
          runtimeConfiguredProviders: [],
          lockReason: null,
          connectedProvider: null,
          setupSatisfied: false,
          setupSatisfiedByRuntimeEnv: false,
          providers: [
            {
              provider: 'ado',
              label: 'Azure DevOps',
              connectionMode: 'token',
              runtimeConfigSatisfied: false,
              savedConfigSatisfied: false,
              configSatisfied: false,
              configStepSatisfied: false,
              configSatisfiedByRuntimeEnv: false,
              connected: false,
              repositoryCount: 0,
              fields,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('ADO Organization (URL slug)')).toBeInTheDocument();
    expect(screen.getByText(/Azure DevOps Access Token/)).toBeInTheDocument();
    expect(screen.getByText(/Azure DevOps Base URL/)).toBeInTheDocument();
    expect(screen.getByText(/Azure DevOps Username/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /Microsoft Entra service principal/ }),
    );
    expect(screen.getByText(/Microsoft Entra Client ID/)).toBeInTheDocument();
    expect(
      screen.getByText(/Microsoft Entra Client Secret/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Entra Tenant ID/)).toBeInTheDocument();
    expect(screen.getByText(/Azure DevOps Webhook Secret/)).toBeInTheDocument();
  });

  it.each([
    ['gitlab', '/api/source-control/gitlab/oauth/callback'],
    ['gitea', '/api/source-control/gitea/oauth/callback'],
    ['bitbucket', '/api/auth/oauth2/callback/bitbucket'],
    ['ado', '/api/auth/oauth2/callback/ado'],
  ] as const)(
    'shows numbered setup instructions and the callback URL for %s',
    (provider, callbackPath) => {
      render(
        <SourceControlConfigForm
          provider={provider}
          configStatus={buildUnconfiguredProviderStatus(provider)}
          showSetupInstructions
        />,
      );

      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(
        screen.getByText(`http://localhost:3000${callbackPath}`),
      ).toBeInTheDocument();
    },
  );

  function buildAdoDelegatedStatus(linkedAccountField: {
    savedSatisfied: boolean;
    savedValue: string | null;
  }): SetupSourceControlStatus {
    const ado = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
      (provider) => provider.provider === 'ado',
    )!;
    const fields = ado.fields.map((field) => ({
      ...field,
      runtimeSatisfied: false,
      savedSatisfied:
        field.envVarName === 'ADO_AUTH_MODE'
          ? true
          : field.envVarName === 'ADO_LINKED_ACCOUNT_ID'
            ? linkedAccountField.savedSatisfied
            : false,
      savedValue:
        field.envVarName === 'ADO_AUTH_MODE'
          ? 'delegated'
          : field.envVarName === 'ADO_LINKED_ACCOUNT_ID'
            ? linkedAccountField.savedValue
            : null,
      satisfiedByEnvVarName: null,
    }));

    return {
      selectedProvider: 'ado',
      preselectedProvider: 'ado',
      runtimeConfiguredProvider: null,
      runtimeConfiguredProviders: [],
      lockReason: null,
      connectedProvider: null,
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
      providers: [
        {
          provider: 'ado',
          label: 'Azure DevOps',
          connectionMode: 'token',
          runtimeConfigSatisfied: false,
          savedConfigSatisfied: false,
          configSatisfied: false,
          configStepSatisfied: true,
          configSatisfiedByRuntimeEnv: false,
          connected: false,
          repositoryCount: 0,
          fields,
        },
      ],
    };
  }

  it('says a linked Azure DevOps account is not in use before its id is saved', () => {
    adoLinkedAccountRef.current = {
      data: {
        configured: true,
        account: { accountId: 'ada@contoso.com', displayName: 'Ada Lovelace' },
      },
      isPending: false,
    };

    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildAdoDelegatedStatus({
          savedSatisfied: false,
          savedValue: null,
        })}
      />,
    );

    expect(screen.getByText(/Connected as Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Not in use yet/)).toBeInTheDocument();
  });

  it('says a reconnected Azure DevOps account is not in use while the saved id still belongs to the previous account', () => {
    adoLinkedAccountRef.current = {
      data: {
        configured: true,
        account: { accountId: 'ada@contoso.com', displayName: 'Ada Lovelace' },
      },
      isPending: false,
    };

    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildAdoDelegatedStatus({
          savedSatisfied: true,
          savedValue: 'grace@contoso.com',
        })}
      />,
    );

    expect(screen.getByText(/Connected as Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Not in use yet/)).toBeInTheDocument();
  });

  it('drops the not-in-use hint once the saved id matches the linked Azure DevOps account', () => {
    adoLinkedAccountRef.current = {
      data: {
        configured: true,
        account: { accountId: 'ada@contoso.com', displayName: 'Ada Lovelace' },
      },
      isPending: false,
    };

    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildAdoDelegatedStatus({
          savedSatisfied: true,
          savedValue: 'ada@contoso.com',
        })}
      />,
    );

    expect(screen.getByText(/Connected as Ada Lovelace/)).toBeInTheDocument();
    expect(screen.queryByText(/Not in use yet/)).not.toBeInTheDocument();
  });
});
