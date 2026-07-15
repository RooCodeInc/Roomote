import { fireEvent, render, screen } from '@testing-library/react';
import {
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG,
  type SetupSourceControlStatus,
} from '@roomote/types';

const { createGitHubAppManifestMock, saveMutationOptionsRef, mutateAsyncMock } =
  vi.hoisted(() => ({
    createGitHubAppManifestMock: vi.fn(),
    mutateAsyncMock: vi.fn(async () => undefined),
    saveMutationOptionsRef: {
      current: null as {
        mutationFn?: (variables: unknown) => Promise<unknown>;
      } | null,
    },
  }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
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
    linkedAccounts: {
      ado: {
        queryKey: () => ['linkedAccounts.ado'],
        queryOptions: () => ({ queryKey: ['linkedAccounts.ado'] }),
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
            envVarName: 'GITLAB_CLIENT_ID',
            acceptedEnvVarNames: ['GITLAB_CLIENT_ID'],
            label: 'GitLab OAuth Client ID',
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

function buildCatalogProviderSetup(
  provider: 'gitlab' | 'gitea' | 'bitbucket',
): SetupSourceControlStatus {
  const descriptor = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
    (candidate) => candidate.provider === provider,
  )!;

  return buildSourceControlSetup({
    preselectedProvider: provider,
    providers: [
      {
        ...descriptor,
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        configSatisfiedByRuntimeEnv: false,
        connected: false,
        repositoryCount: 0,
        fields: descriptor.fields.map((field) => ({
          ...field,
          runtimeSatisfied: false,
          savedSatisfied: false,
          satisfiedByEnvVarName: null,
        })),
      },
    ],
  });
}

describe('StepSourceControlConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('guides GitLab OAuth application setup', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildCatalogProviderSetup('gitlab')}
        selectedProviderId="gitlab"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getAllByText(/GitLab OAuth application/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/In GitLab, click on your avatar/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/GitLab Webhook Secret/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create GitHub App' }),
    ).not.toBeInTheDocument();
  });

  it('guides Gitea OAuth application setup', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildCatalogProviderSetup('gitea')}
        selectedProviderId="gitea"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByText('Gitea Base URL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://gitea.com')).toBeInTheDocument();
    expect(screen.getByText(/Gitea OAuth Client ID/)).toBeInTheDocument();
    expect(screen.getByText(/Gitea OAuth Client Secret/)).toBeInTheDocument();
    expect(screen.getByText(/Gitea 1\.23\+/)).toBeInTheDocument();
    expect(screen.getByText('Deployment callback')).toBeInTheDocument();
    expect(
      screen.getByText(/api\/source-control\/gitea\/oauth\/callback/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Account linking callback'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/api\/auth\/oauth2\/callback\/gitea/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Gitea Access Token')).not.toBeInTheDocument();
    expect(screen.queryByText('Gitea Username')).not.toBeInTheDocument();
    expect(screen.queryByText('Gitea Webhook Secret')).not.toBeInTheDocument();
  });

  it('guides Bitbucket token creation without optional credentials', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildCatalogProviderSetup('bitbucket')}
        selectedProviderId="bitbucket"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByText('Bitbucket API Token')).toBeInTheDocument();
    expect(screen.getByText('Atlassian Account Email')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute(
      'href',
      'https://id.atlassian.com/manage-profile/security/api-tokens',
    );
    expect(
      screen.getByText(/Create API token with scopes → Bitbucket/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Bitbucket Base URL')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Bitbucket OAuth Client ID'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Bitbucket Webhook Secret'),
    ).not.toBeInTheDocument();
  });

  function buildAdoSourceControlSetup(
    fieldOverrides: Partial<
      SetupSourceControlStatus['providers'][number]['fields'][number]
    >[] = [],
  ): SetupSourceControlStatus {
    const catalog = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
      (provider) => provider.provider === 'ado',
    )!;
    const fields = catalog.fields.map((field, index) => ({
      ...field,
      runtimeSatisfied: false,
      savedSatisfied: false,
      satisfiedByEnvVarName: null,
      ...fieldOverrides[index],
    }));

    return buildSourceControlSetup({
      preselectedProvider: 'ado',
      providers: [
        {
          provider: 'ado',
          label: 'Azure DevOps',
          connectionMode: 'token',
          runtimeConfigSatisfied: false,
          savedConfigSatisfied: false,
          configSatisfied: false,
          configSatisfiedByRuntimeEnv: false,
          connected: false,
          repositoryCount: 0,
          fields,
        },
      ],
    });
  }

  it('defaults Azure DevOps setup to delegated authentication', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildAdoSourceControlSetup()}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByText('Azure DevOps Organization')).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Entra Client ID/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Azure DevOps Access Token/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show advanced config' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Azure DevOps Base URL/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Azure DevOps Username/)).not.toBeInTheDocument();
    expect(screen.getByText(/Microsoft Entra Client ID/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Azure DevOps Webhook Secret/),
    ).not.toBeInTheDocument();
  });

  it('shows mode-specific Azure DevOps creation instructions in step two', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildAdoSourceControlSetup()}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('link', {
        name: /Azure App registrations/i,
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Personal access token/i }),
    );
    expect(
      screen.getByText(/Create a personal access token \(PAT\)/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Microsoft Entra service principal/ }),
    );
    expect(
      screen.getByText('Create a Microsoft Entra app.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Azure App registrations/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect with your Microsoft account/,
      }),
    );
    expect(screen.getAllByText(/Web redirect URI/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/\/api\/auth\/oauth2\/callback\/ado/),
    ).toBeInTheDocument();
  });

  it('reveals optional Azure DevOps fields without showing the webhook secret', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildAdoSourceControlSetup()}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Personal access token/i }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Show advanced config' }),
    );

    expect(screen.getByText(/Azure DevOps Base URL/)).toBeInTheDocument();
    expect(screen.getByText(/Azure DevOps Username/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Microsoft Entra Client ID/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Microsoft Entra Client Secret/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Microsoft Entra Tenant ID/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Azure DevOps Webhook Secret/),
    ).not.toBeInTheDocument();
  });

  it('keeps optional Azure DevOps fields closed when switching auth modes', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildAdoSourceControlSetup()}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Microsoft Entra service principal/ }),
    );

    expect(
      screen.getByRole('button', { name: 'Show advanced config' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Entra Client ID/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect with your Microsoft account/,
      }),
    );

    expect(
      screen.getByText('Create a Microsoft Entra app.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Azure App registrations/i }),
    ).toHaveAttribute(
      'href',
      'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    );

    expect(
      screen.getByRole('button', { name: 'Show advanced config' }),
    ).toBeInTheDocument();
  });

  it('does not block continue on hidden optional Azure DevOps fields', () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildAdoSourceControlSetup()}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('ADO_ORGANIZATION'), {
      target: { value: 'my-org' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Personal access token/i }),
    );
    fireEvent.change(screen.getByPlaceholderText('ADO_TOKEN'), {
      target: { value: 'ado-pat' },
    });

    expect(
      screen.getByRole('button', { name: /Save and continue/i }),
    ).toBeEnabled();
  });

  it('submits only visible Azure DevOps values when advanced config is closed', async () => {
    const setup = buildAdoSourceControlSetup();
    const provider = setup.providers[0]!;
    const baseUrlField = provider.fields.find(
      (field) => field.envVarName === 'ADO_BASE_URL',
    )!;
    baseUrlField.savedSatisfied = true;
    baseUrlField.savedValue = 'https://ado.example.com';
    baseUrlField.satisfiedByEnvVarName = 'ADO_BASE_URL';

    render(
      <StepSourceControlConfig
        sourceControlSetup={setup}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('ADO_ORGANIZATION'), {
      target: { value: 'my-org' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Personal access token/i }),
    );
    fireEvent.change(screen.getByPlaceholderText('ADO_TOKEN'), {
      target: { value: 'ado-pat' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/i }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'ado',
      values: {
        ADO_ORGANIZATION: 'my-org',
        ADO_TOKEN: 'ado-pat',
        ADO_AUTH_MODE: 'pat',
        ADO_LINKED_ACCOUNT_ID: '',
      },
    });
  });

  it('keeps Entra values separate from PAT values', async () => {
    render(
      <StepSourceControlConfig
        sourceControlSetup={buildAdoSourceControlSetup()}
        selectedProviderId="ado"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('ADO_ORGANIZATION'), {
      target: { value: 'my-org' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Microsoft Entra service principal/ }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Show advanced config' }),
    );
    fireEvent.change(screen.getByPlaceholderText('ADO_BASE_URL'), {
      target: { value: 'https://ado.example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('ADO_USERNAME'), {
      target: { value: 'service-user' },
    });
    fireEvent.change(screen.getByPlaceholderText('ADO_CLIENT_ID'), {
      target: { value: 'client-id' },
    });
    fireEvent.change(screen.getByPlaceholderText('ADO_CLIENT_SECRET'), {
      target: { value: 'client-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('ADO_TENANT_ID'), {
      target: { value: 'tenant-id' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/i }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'ado',
      values: {
        ADO_ORGANIZATION: 'my-org',
        ADO_BASE_URL: 'https://ado.example.com',
        ADO_USERNAME: 'service-user',
        ADO_CLIENT_ID: 'client-id',
        ADO_CLIENT_SECRET: 'client-secret',
        ADO_TENANT_ID: 'tenant-id',
        ADO_AUTH_MODE: 'entra',
        ADO_LINKED_ACCOUNT_ID: '',
      },
    });
  });
});
