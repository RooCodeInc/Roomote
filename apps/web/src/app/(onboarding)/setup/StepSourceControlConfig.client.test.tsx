import { fireEvent, render, screen } from '@testing-library/react';
import {
  buildSetupSourceControlStatus,
  type SetupSourceControlStatus,
} from '@roomote/types';

const {
  authenticateAdoAccountMock,
  createGitHubAppManifestMock,
  mutateAsyncMock,
  saveMutationOptionsRef,
} = vi.hoisted(() => ({
  authenticateAdoAccountMock: vi.fn(),
  createGitHubAppManifestMock: vi.fn(),
  mutateAsyncMock: vi.fn(),
  saveMutationOptionsRef: {
    current: null as {
      mutationFn?: (variables: unknown) => Promise<unknown>;
    } | null,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof saveMutationOptionsRef.current) => {
    saveMutationOptionsRef.current = options;

    return {
      mutateAsync: mutateAsyncMock,
      isPending: false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      saveSourceControlConfig: {
        mutationOptions: (options: unknown) => options,
      },
      status: {
        queryKey: () => ['setupNew.status'],
      },
    },
  }),
}));

vi.mock('@/hooks/github', () => ({
  useCreateGitHubAppManifest: () => ({
    mutate: createGitHubAppManifestMock,
    isPending: false,
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

import { StepSourceControlConfig } from './StepSourceControlConfig';

function buildSourceControlSetup(
  overrides: Partial<SetupSourceControlStatus> = {},
): SetupSourceControlStatus {
  return {
    selectedProvider: null,
    preselectedProvider: 'github',
    runtimeConfiguredProvider: null,
    runtimeConfiguredProviders: [],
    lockReason: null,
    connectedProvider: null,
    setupSatisfied: false,
    setupSatisfiedByRuntimeEnv: false,
    providers: [
      {
        provider: 'github',
        label: 'GitHub',
        connectionMode: 'app',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        configSatisfiedByRuntimeEnv: false,
        connected: false,
        repositoryCount: 0,
        fields: [
          {
            envVarName: 'R_GITHUB_APP_SLUG',
            acceptedEnvVarNames: ['R_GITHUB_APP_SLUG'],
            label: 'GitHub App Slug',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_GITHUB_APP_ID',
            acceptedEnvVarNames: ['R_GITHUB_APP_ID'],
            label: 'GitHub App ID',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
        ],
      },
      {
        provider: 'gitlab',
        label: 'GitLab',
        connectionMode: 'token',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        configSatisfiedByRuntimeEnv: false,
        connected: false,
        repositoryCount: 0,
        fields: [
          {
            envVarName: 'GITLAB_TOKEN',
            acceptedEnvVarNames: ['GITLAB_TOKEN'],
            label: 'GitLab Personal Access Token',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('StepSourceControlConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsyncMock.mockResolvedValue(undefined);
  });

  it('defaults GitHub setup to the manifest CTA', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSourceControlSetup()}
        selectedProviderId="github"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Create GitHub App' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enter values manually' }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('GitHub organization (optional)'),
    ).toBeInTheDocument();
    expect(screen.queryByText('GitHub App ID')).not.toBeInTheDocument();
  });

  it('creates the app on the personal account when no organization is entered', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSourceControlSetup()}
        selectedProviderId="github"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));

    expect(createGitHubAppManifestMock).toHaveBeenCalledWith({
      redirect: '/setup?step=source-control-connect',
      organization: null,
    });
  });

  it('passes the entered organization through to app creation', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSourceControlSetup()}
        selectedProviderId="github"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('GitHub organization (optional)'), {
      target: { value: ' example-org ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));

    expect(createGitHubAppManifestMock).toHaveBeenCalledWith({
      redirect: '/setup?step=source-control-connect',
      organization: 'example-org',
    });
  });

  it('reveals the existing GitHub field form from the manual path', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSourceControlSetup()}
        selectedProviderId="github"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Enter values manually' }),
    );

    expect(screen.getByText('GitHub App Slug')).toBeInTheDocument();
    expect(screen.getByText('GitHub App ID')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Save and continue/i }),
    ).toBeInTheDocument();
  });

  it('keeps token-backed providers on the existing config form', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSourceControlSetup()}
        selectedProviderId="gitlab"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText('GitLab Personal Access Token'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create GitHub App' }),
    ).not.toBeInTheDocument();
  });

  it('asks for the Azure DevOps organization before showing PAT setup', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    const organizationInput = screen.getByLabelText(
      'Azure DevOps Organization',
    );
    const continueButton = screen.getByRole('button', { name: 'Continue' });

    expect(organizationInput).toBeInTheDocument();
    expect(continueButton).toBeDisabled();
    expect(
      screen.queryByLabelText('Azure DevOps Access Token'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create Azure DevOps PAT' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Azure DevOps Base URL/),
    ).not.toBeInTheDocument();

    fireEvent.change(organizationInput, { target: { value: ' acme ' } });

    expect(continueButton).toBeEnabled();
  });

  it('rejects organization URLs and malformed cloud organization names', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    const organizationInput = screen.getByLabelText(
      'Azure DevOps Organization',
    );
    const continueButton = screen.getByRole('button', { name: 'Continue' });

    fireEvent.change(organizationInput, {
      target: { value: 'https://dev.azure.com/acme' },
    });

    expect(organizationInput).toHaveAttribute('aria-invalid', 'true');
    expect(continueButton).toBeDisabled();
    expect(
      screen.getByText(/Use only letters, numbers, and hyphens/),
    ).toBeVisible();

    fireEvent.change(organizationInput, {
      target: { value: 'acme org' },
    });

    expect(continueButton).toBeDisabled();
  });

  it('uses PAT instructions instead of a cloud link for Azure DevOps Server', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Using Azure DevOps Server?' }),
    );
    fireEvent.change(screen.getByLabelText(/Azure DevOps Base URL/), {
      target: { value: 'https://ado.example.com/tfs' },
    });
    fireEvent.change(screen.getByLabelText('Azure DevOps Organization'), {
      target: { value: 'Default Collection' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.getByRole('link', { name: 'View PAT setup instructions' }),
    ).toHaveAttribute(
      'href',
      'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops',
    );
    expect(
      screen.queryByRole('link', { name: 'Create Azure DevOps PAT' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Azure DevOps Base URL/),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show advanced options' }),
    );
    expect(screen.getByLabelText(/Azure DevOps Base URL/)).toHaveValue(
      'https://ado.example.com/tfs',
    );

    fireEvent.change(screen.getByLabelText('Azure DevOps Access Token'), {
      target: { value: 'ado-pat' },
    });
    expect(
      screen.getByRole('button', { name: 'Save and continue' }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/Azure DevOps Base URL/), {
      target: { value: 'ado.example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide advanced options' }),
    );
    expect(
      screen.getByText('Enter a valid HTTP or HTTPS Azure DevOps Server URL.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Show advanced options' }),
    ).toHaveAttribute('aria-describedby', 'setup-ado-advanced-options-error');
    expect(
      screen.getByRole('button', { name: 'Save and continue' }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show advanced options' }),
    );
    fireEvent.change(screen.getByLabelText(/Azure DevOps Base URL/), {
      target: { value: '' },
    });
    expect(
      screen.getByText(/Use only letters, numbers, and hyphens/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save and link account' }),
    ).toBeDisabled();
  });

  it('links to PAT creation for the entered organization and can go back', () => {
    const onBack = vi.fn();

    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
        selectedProviderId="ado"
        onContinue={vi.fn()}
        onBack={onBack}
      />,
    );

    fireEvent.change(screen.getByLabelText('Azure DevOps Organization'), {
      target: { value: ' acme ' },
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
    expect(screen.getByText('acme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByLabelText('Azure DevOps Organization')).toHaveValue(
      'acme',
    );
    expect(onBack).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'saved',
      status: buildSetupSourceControlStatus({
        selectedProvider: 'ado',
        persistedEnvVarNames: ['ADO_ORGANIZATION'],
        persistedEnvVarValues: { ADO_ORGANIZATION: 'saved-org' },
      }),
      organization: 'saved-org',
    },
    {
      name: 'runtime',
      status: buildSetupSourceControlStatus({
        selectedProvider: 'ado',
        runtimeEnv: { ADO_ORGANIZATION: 'runtime-org' },
      }),
      organization: 'runtime-org',
    },
  ])(
    'uses a $name organization for the PAT link',
    ({ name, status, organization }) => {
      render(
        <StepSourceControlConfig
          sourceControlSetup={status}
          selectedProviderId="ado"
          onContinue={vi.fn()}
        />,
      );

      expect(
        screen.getByRole('link', { name: 'Create Azure DevOps PAT' }),
      ).toHaveAttribute(
        'href',
        `https://dev.azure.com/${organization}/_usersSettings/tokens`,
      );

      if (name === 'runtime') {
        expect(
          screen.queryByRole('button', { name: 'Change organization' }),
        ).not.toBeInTheDocument();
        expect(
          screen.getByText('Managed by runtime configuration'),
        ).toBeVisible();
        expect(
          screen.queryByRole('button', { name: 'Back' }),
        ).not.toBeInTheDocument();
      }
    },
  );

  it('separates Azure DevOps account linking from advanced options', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Azure DevOps Organization'), {
      target: { value: 'acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.queryByLabelText(/Azure DevOps Base URL/),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Microsoft Entra Client ID')).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show advanced options' }),
    );

    expect(screen.getByText('Azure DevOps Base URL (optional)')).toBeVisible();
    expect(screen.getByText('Azure DevOps Username (optional)')).toBeVisible();
    expect(screen.getByText('Microsoft Entra Client ID')).toBeVisible();
    expect(
      screen.getByText('Azure DevOps Webhook Secret (optional)'),
    ).toBeVisible();

    expect(screen.getByText('Microsoft Entra Client ID')).toBeVisible();
    expect(screen.getByText('Microsoft Entra Client Secret')).toBeVisible();
    expect(
      screen.getByText(
        'Microsoft Entra Tenant ID (required unless multi-tenant)',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/tenant ID is required unless the app supports/),
    ).toBeVisible();
    expect(
      screen.getByText(/If Microsoft Teams or Microsoft sign-in/),
    ).toBeVisible();
    expect(
      screen.getByText(/\/api\/auth\/oauth2\/callback\/ado$/),
    ).toBeVisible();
  });

  it('requires OAuth setup and saves it with the organization and PAT', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildSetupSourceControlStatus({
          selectedProvider: 'ado',
        })}
        selectedProviderId="ado"
        onContinue={vi.fn()}
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

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'ado',
      values: {
        ADO_CLIENT_ID: 'client-id',
        ADO_CLIENT_SECRET: 'client-secret',
        ADO_ORGANIZATION: 'acme',
        ADO_TOKEN: 'ado-pat',
      },
    });
  });
});
