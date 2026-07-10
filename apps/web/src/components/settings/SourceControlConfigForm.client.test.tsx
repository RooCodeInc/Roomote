import { render, screen } from '@testing-library/react';
import type { SetupSourceControlStatus } from '@roomote/types';

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
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

import { SourceControlConfigForm } from './SourceControlConfigForm';
const MASKED_VALUE = '••••••••••••••••••••••••••••';

function buildConfigStatus(
  fields: SetupSourceControlStatus['providers'][number]['fields'],
): SetupSourceControlStatus {
  return {
    selectedProvider: 'github',
    preselectedProvider: 'github',
    runtimeConfiguredProvider: 'github',
    runtimeConfiguredProviders: ['github'],
    lockReason: 'runtime_env',
    connectedProvider: 'github',
    setupSatisfied: true,
    setupSatisfiedByRuntimeEnv: true,
    providers: [
      {
        provider: 'github',
        label: 'GitHub',
        connectionMode: 'app',
        runtimeConfigSatisfied: true,
        savedConfigSatisfied: false,
        configSatisfied: true,
        configSatisfiedByRuntimeEnv: true,
        connected: true,
        repositoryCount: 2,
        fields,
      },
    ],
  };
}

describe('SourceControlConfigForm', () => {
  it('shows plain values for non-secrets and a mask for secrets when runtime-configured', () => {
    render(
      <SourceControlConfigForm
        provider="github"
        configStatus={buildConfigStatus([
          {
            envVarName: 'NEXT_PUBLIC_GITHUB_APP_SLUG',
            acceptedEnvVarNames: [
              'NEXT_PUBLIC_GITHUB_APP_SLUG',
              'GITHUB_APP_SLUG',
            ],
            label: 'GitHub App Slug',
            runtimeSatisfied: true,
            savedSatisfied: false,
            savedValue: 'roomote-app',
            satisfiedByEnvVarName: 'NEXT_PUBLIC_GITHUB_APP_SLUG',
          },
          {
            envVarName: 'GITHUB_APP_ID',
            acceptedEnvVarNames: ['GITHUB_APP_ID'],
            label: 'GitHub App ID',
            runtimeSatisfied: true,
            savedSatisfied: false,
            savedValue: '12345',
            satisfiedByEnvVarName: 'GITHUB_APP_ID',
          },
          {
            envVarName: 'GITHUB_APP_PRIVATE_KEY',
            acceptedEnvVarNames: ['GITHUB_APP_PRIVATE_KEY'],
            label: 'GitHub App Private Key',
            secret: true,
            runtimeSatisfied: true,
            savedSatisfied: false,
            savedValue: null,
            satisfiedByEnvVarName: 'GITHUB_APP_PRIVATE_KEY',
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
            envVarName: 'NEXT_PUBLIC_GITHUB_APP_SLUG',
            acceptedEnvVarNames: [
              'NEXT_PUBLIC_GITHUB_APP_SLUG',
              'GITHUB_APP_SLUG',
            ],
            label: 'GitHub App Slug',
            runtimeSatisfied: false,
            savedSatisfied: true,
            savedValue: 'saved-slug',
            satisfiedByEnvVarName: 'NEXT_PUBLIC_GITHUB_APP_SLUG',
          },
          {
            envVarName: 'GITHUB_CLIENT_SECRET',
            acceptedEnvVarNames: ['GITHUB_CLIENT_SECRET'],
            label: 'GitHub OAuth Client Secret',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: true,
            savedValue: null,
            satisfiedByEnvVarName: 'GITHUB_CLIENT_SECRET',
          },
        ])}
      />,
    );

    expect(screen.getByDisplayValue('saved-slug')).not.toBeDisabled();
    expect(screen.getByDisplayValue(MASKED_VALUE)).not.toBeDisabled();
  });
});
