import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SetupComputeStatus } from '@roomote/types';

import { ComputeProviders } from './ComputeProviders';

const { state, statusQueryMock } = vi.hoisted(() => ({
  state: {
    failStatusQuery: false,
    status: null as SetupComputeStatus | null,
  },
  statusQueryMock: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    compute: {
      status: {
        queryKey: () => ['compute', 'status'],
        queryOptions: (_input: undefined, options: object) => ({
          queryKey: ['compute', 'status'],
          queryFn: statusQueryMock,
          ...options,
        }),
      },
      saveConfig: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      clearConfig: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      setDefaultProvider: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      setLocalDockerEnabled: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
    },
    environmentVariables: {
      list: { queryKey: () => ['environmentVariables', 'list'] },
    },
  }),
}));

vi.mock('./DockerEnvironmentValidation', () => ({
  DockerEnvironmentValidation: () => null,
}));

const healthyStatus: SetupComputeStatus = {
  selectedProvider: null,
  preselectedProvider: 'docker',
  runtimeDefaultProvider: 'docker',
  persistedDefaultProvider: null,
  setupSatisfied: true,
  setupSatisfiedByRuntimeEnv: true,
  workerImage: {
    envVarName: 'DOCKER_WORKER_IMAGE',
    label: 'Worker Image',
    runtimeSatisfied: true,
    savedSatisfied: false,
    hostedImageRef: 'ghcr.io/roocodeinc/roomote-worker:test',
    hostedReady: true,
  },
  providers: [
    {
      provider: 'docker',
      label: 'Local Docker',
      description: 'Local task sandboxes.',
      supportsSnapshots: true,
      fields: [],
      runtimeConfigSatisfied: true,
      savedConfigSatisfied: false,
      configSatisfied: true,
      infrastructureSatisfied: true,
    },
  ],
};

function renderProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ComputeProviders />
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('ComputeProviders status recovery', () => {
  beforeEach(() => {
    state.failStatusQuery = false;
    state.status = healthyStatus;
    statusQueryMock.mockReset();
    statusQueryMock.mockImplementation(async () => {
      if (state.failStatusQuery) {
        throw new Error('Status unavailable');
      }

      return state.status;
    });
  });

  it('retries an initial status failure and restores provider configuration', async () => {
    state.failStatusQuery = true;
    renderProviders();

    expect(
      await screen.findByText('Failed to load sandbox provider status.'),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(statusQueryMock).toHaveBeenCalledTimes(1);

    state.failStatusQuery = false;
    fireEvent.click(retry);

    expect(
      await screen.findByText('Default sandbox provider'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveTextContent('Local Docker');
    expect(
      screen.queryByText('Failed to load sandbox provider status.'),
    ).not.toBeInTheDocument();
    expect(statusQueryMock).toHaveBeenCalledTimes(2);
  });

  it('keeps cached provider configuration visible after a failed refetch', async () => {
    const queryClient = renderProviders();

    expect(
      await screen.findByText('Default sandbox provider'),
    ).toBeInTheDocument();
    state.failStatusQuery = true;

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['compute', 'status'] });
    });
    await waitFor(() => expect(statusQueryMock).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('combobox')).toHaveTextContent('Local Docker');
    expect(
      screen.queryByText('Failed to load sandbox provider status.'),
    ).not.toBeInTheDocument();
  });
});
