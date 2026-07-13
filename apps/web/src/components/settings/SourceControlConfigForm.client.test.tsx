import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  buildSetupSourceControlStatus,
  type SetupSourceControlStatus,
} from '@roomote/types';

const {
  authenticateAdoAccountMock,
  mutateMock,
  mutationOptionsRef,
  invalidateQueriesMock,
} = vi.hoisted(() => ({
  authenticateAdoAccountMock: vi.fn(),
  mutateMock: vi.fn(),
  mutationOptionsRef: {
    current: null as {
      onSuccess?: () => Promise<void> | void;
      onError?: (error: Error) => void;
    } | null,
  },
  invalidateQueriesMock: vi.fn(async () => undefined),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof mutationOptionsRef.current) => {
    mutationOptionsRef.current = options;
    return {
      mutate: mutateMock,
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

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sourceControl: {
      saveConfig: {
        mutationOptions: (options: unknown) => options,
      },
      configStatus: {
        queryKey: () => ['sourceControl.configStatus'],
      },
      repositories: {
        queryKey: () => ['sourceControl.repositories'],
      },
    },
  }),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useAdoLinkedAccount: () => ({
    data: { configured: false, account: null },
    isPending: false,
  }),
  useAuthenticateAdoAccount: () => ({
    mutate: authenticateAdoAccountMock,
    isPending: false,
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
        configSatisfiedByRuntimeEnv: false,
        connected: true,
        repositoryCount: 2,
        fields,
      },
    ],
  };
}

describe('SourceControlConfigForm', () => {
  beforeEach(() => {
    mutateMock.mockReset();
    invalidateQueriesMock.mockClear();
    mutationOptionsRef.current = null;
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
      await mutationOptionsRef.current?.onSuccess?.();
    });

    await waitFor(() => {
      expect(screen.queryByDisplayValue('new-secret-value')).toBeNull();
      expect(screen.getByDisplayValue(MASKED_VALUE)).toBeInTheDocument();
      expect(screen.getByDisplayValue('saved-slug')).toBeInTheDocument();
    });
  });

  it('uses the organization-first Azure DevOps setup flow', () => {
    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
      />,
    );

    expect(
      screen.getByLabelText('Azure DevOps Organization'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Azure DevOps Access Token'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create Azure DevOps PAT' }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Azure DevOps Organization'), {
      target: { value: 'acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.getByRole('link', { name: 'Create Azure DevOps PAT' }),
    ).toHaveAttribute(
      'href',
      'https://dev.azure.com/acme/_usersSettings/tokens',
    );
    expect(
      screen.getByLabelText('Azure DevOps Access Token'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Azure DevOps Base URL/),
    ).not.toBeInTheDocument();

    const advancedOptionsButton = screen.getByRole('button', {
      name: 'Show advanced options',
    });
    expect(advancedOptionsButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(advancedOptionsButton);

    expect(screen.getByText('Azure DevOps Base URL (optional)')).toBeVisible();
    expect(advancedOptionsButton).toHaveAttribute('aria-expanded', 'true');
  });

  it('builds the Azure DevOps PAT link from a runtime organization', () => {
    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
          runtimeEnv: { ADO_ORGANIZATION: 'runtime-org' },
        })}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Create Azure DevOps PAT' }),
    ).toHaveAttribute(
      'href',
      'https://dev.azure.com/runtime-org/_usersSettings/tokens',
    );
    expect(
      screen.queryByRole('button', { name: 'Change organization' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Managed by runtime configuration')).toBeVisible();
  });

  it('does not send a custom Azure DevOps Server user to the cloud PAT page', () => {
    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
          runtimeEnv: {
            ADO_ORGANIZATION: 'Default Collection',
            ADO_BASE_URL: 'https://ado.example.com/tfs',
          },
        })}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'View PAT setup instructions' }),
    ).toHaveAttribute(
      'href',
      'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops',
    );
    expect(
      screen.queryByRole('link', { name: 'Create Azure DevOps PAT' }),
    ).not.toBeInTheDocument();
  });

  it('requires OAuth when saving an Azure DevOps cloud configuration', () => {
    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText('Azure DevOps Organization'), {
      target: { value: ' acme ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps Access Token'), {
      target: { value: 'ado-pat' },
    });
    expect(
      screen.getByRole('button', { name: 'Save and link account' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Microsoft Entra Client ID'), {
      target: { value: 'client-id' },
    });
    fireEvent.change(screen.getByLabelText('Microsoft Entra Client Secret'), {
      target: { value: 'client-secret' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save and link account' }),
    );

    expect(mutateMock).toHaveBeenCalledWith({
      provider: 'ado',
      values: {
        ADO_CLIENT_ID: 'client-id',
        ADO_CLIENT_SECRET: 'client-secret',
        ADO_ORGANIZATION: 'acme',
        ADO_TOKEN: 'ado-pat',
      },
    });
  });

  it('saves OAuth credentials and immediately starts account linking', async () => {
    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText('Azure DevOps Organization'), {
      target: { value: 'acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps Access Token'), {
      target: { value: 'ado-pat' },
    });
    fireEvent.change(screen.getByLabelText(/Microsoft Entra Client ID/), {
      target: { value: 'client-id' },
    });
    expect(
      screen.getByText(/Enter both the Microsoft Entra application/),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Microsoft Entra Client Secret/), {
      target: { value: 'client-secret' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save and link account' }),
    );

    expect(mutateMock).toHaveBeenCalledWith({
      provider: 'ado',
      values: {
        ADO_CLIENT_ID: 'client-id',
        ADO_CLIENT_SECRET: 'client-secret',
        ADO_ORGANIZATION: 'acme',
        ADO_TOKEN: 'ado-pat',
      },
    });

    await act(async () => {
      await mutationOptionsRef.current?.onSuccess?.();
    });

    expect(authenticateAdoAccountMock).toHaveBeenCalledWith(
      '/settings?service=ado',
    );
  });

  it('reuses existing Microsoft setup before linking the Azure DevOps account', async () => {
    render(
      <SourceControlConfigForm
        provider="ado"
        configStatus={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
          runtimeEnv: {
            ADO_ORGANIZATION: 'acme',
            ADO_TOKEN: 'ado-pat',
            R_MICROSOFT_CLIENT_ID: 'client-id',
            R_MICROSOFT_CLIENT_SECRET: 'client-secret',
            R_MICROSOFT_TENANT_ID: 'tenant-id',
          },
        })}
      />,
    );

    expect(
      screen.getByText(/found your existing Microsoft setup/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Link account' }));

    await act(async () => {
      await mutationOptionsRef.current?.onSuccess?.();
    });

    expect(authenticateAdoAccountMock).toHaveBeenCalledWith(
      '/settings?service=ado',
    );
  });
});
