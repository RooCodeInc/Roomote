import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { SetupSourceControlStatus } from '@roomote/types';

const { mutateMock, mutationOptionsRef, invalidateQueriesMock } = vi.hoisted(
  () => ({
    mutateMock: vi.fn(),
    mutationOptionsRef: {
      current: null as {
        onSuccess?: () => Promise<void> | void;
        onError?: (error: Error) => void;
      } | null,
    },
    invalidateQueriesMock: vi.fn(async () => undefined),
  }),
);

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
});
