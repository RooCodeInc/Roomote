import { fireEvent, render, screen } from '@testing-library/react';
import type { SetupSourceControlStatus } from '@roomote/types';

const { createGitHubAppManifestMock, saveMutationOptionsRef } = vi.hoisted(
  () => ({
    createGitHubAppManifestMock: vi.fn(),
    saveMutationOptionsRef: {
      current: null as {
        mutationFn?: (variables: unknown) => Promise<unknown>;
      } | null,
    },
  }),
);

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof saveMutationOptionsRef.current) => {
    saveMutationOptionsRef.current = options;

    return {
      mutateAsync: vi.fn(),
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
      target: { value: ' roovetgit ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));

    expect(createGitHubAppManifestMock).toHaveBeenCalledWith({
      redirect: '/setup?step=source-control-connect',
      organization: 'roovetgit',
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
});
