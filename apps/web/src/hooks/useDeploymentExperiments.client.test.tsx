import { act, renderHook } from '@testing-library/react';

import { getDeploymentExperimentValues } from '@roomote/feature-flags';

const { mocks, queryState } = vi.hoisted(() => ({
  mocks: {
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    mutate: vi.fn(),
    mutationRoute: null as string | null,
    refetch: vi.fn(),
    runtimeQueryOptions: vi.fn(),
    setQueryData: vi.fn(),
    toastError: vi.fn(),
  },
  queryState: {
    data: undefined as
      | ReturnType<typeof getDeploymentExperimentValues>
      | boolean
      | undefined,
    error: null as Error | null,
    isFetching: false,
    isPending: true,
    nightlyExperimentsEnabled: false,
  },
}));

let mutationOptions: Record<string, (...args: never[]) => unknown>;

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ ...queryState, refetch: mocks.refetch }),
  useMutation: (options: typeof mutationOptions) => {
    mutationOptions = options;
    return { isPending: false, mutate: mocks.mutate };
  },
  useQueryClient: () => ({
    cancelQueries: mocks.cancelQueries,
    getQueryData: mocks.getQueryData,
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    nightlyExperimentsEnabled: queryState.nightlyExperimentsEnabled,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    deploymentExperiments: {
      get: {
        queryKey: () => ['deployment-experiments'],
        queryOptions: () => ({}),
      },
      set: {
        mutationOptions: (options: unknown) => {
          mocks.mutationRoute = 'customer-preview';
          return options;
        },
      },
    },
    nightlyExperiments: {
      get: {
        queryKey: () => ['nightly-experiments'],
        queryOptions: () => ({}),
      },
      runtime: {
        queryKey: ({ id }: { id: string }) => [
          'nightly-experiment-runtime',
          id,
        ],
        queryOptions: (input: unknown, options: unknown) => {
          mocks.runtimeQueryOptions(input, options);
          return { input, options };
        },
      },
      set: {
        mutationOptions: (options: unknown) => {
          mocks.mutationRoute = 'internal-nightly';
          return options;
        },
      },
    },
  }),
}));

import {
  useDeploymentExperimentRuntime,
  useDeploymentExperiment,
  useDeploymentExperiments,
} from './useDeploymentExperiments';

describe('useDeploymentExperiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutationRoute = null;
    queryState.data = getDeploymentExperimentValues(undefined);
    queryState.error = null;
    queryState.isFetching = false;
    queryState.isPending = false;
    queryState.nightlyExperimentsEnabled = false;
  });

  it('exposes the same shared value to every consumer hook', () => {
    queryState.data = {
      ...getDeploymentExperimentValues(undefined),
      privateSessions: true,
    };

    const first = renderHook(() =>
      useDeploymentExperiment('privateSessions', 'fail'),
    );
    const second = renderHook(() =>
      useDeploymentExperiment('privateSessions', 'fail'),
    );

    expect(first.result.current.enabled).toBe(true);
    expect(second.result.current.enabled).toBe(true);
  });

  it('sends one deployment experiment mutation', () => {
    const { result } = renderHook(() => useDeploymentExperiments());

    act(() => result.current.setExperiment('privateSessions', true));

    expect(mocks.mutate).toHaveBeenCalledWith({
      id: 'privateSessions',
      enabled: true,
    });
    expect(mocks.mutationRoute).toBe('customer-preview');
  });

  it('uses the nightly read/write procedures for nightly settings', () => {
    renderHook(() =>
      useDeploymentExperiments('Save failed', 'internal-nightly'),
    );

    expect(mocks.mutationRoute).toBe('internal-nightly');
  });

  it('refreshes Auto runtime consumers after changing its nightly experiment', async () => {
    renderHook(() =>
      useDeploymentExperiments('Save failed', 'internal-nightly'),
    );

    await mutationOptions.onSettled!(
      undefined as never,
      undefined as never,
      { id: 'integrationToolAutoApprovals', enabled: true } as never,
      undefined as never,
      undefined as never,
    );

    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['nightly-experiments'],
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['nightly-experiment-runtime', 'integrationToolAutoApprovals'],
    });
  });

  it('does not invalidate a runtime reader for a nightly setting without one', async () => {
    renderHook(() =>
      useDeploymentExperiments('Save failed', 'internal-nightly'),
    );

    await mutationOptions.onSettled!(
      undefined as never,
      undefined as never,
      { id: 'automationLaunchCriteria', enabled: true } as never,
      undefined as never,
      undefined as never,
    );

    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['nightly-experiments'],
    });
  });

  it.each(['integrationToolAutoApprovals'] as const)(
    'reads the shared nightly runtime resource for %s',
    (id) => {
      queryState.nightlyExperimentsEnabled = true;
      queryState.data = true;

      const { result } = renderHook(() => useDeploymentExperimentRuntime(id));

      expect(result.current).toEqual({ enabled: true, isLoading: false });
      expect(mocks.runtimeQueryOptions).toHaveBeenCalledWith(
        { id },
        { enabled: true },
      );
    },
  );

  it('optimistically updates and rolls back only the changed deployment flag', async () => {
    const previous = getDeploymentExperimentValues(undefined);
    mocks.getQueryData.mockReturnValue(previous);
    renderHook(() => useDeploymentExperiments('Save failed'));

    const variables = {
      id: 'browserNotifications',
      enabled: true,
    } as const;
    const context = await mutationOptions.onMutate!(variables as never);

    expect(mocks.setQueryData).toHaveBeenCalledWith(
      ['deployment-experiments'],
      { ...previous, browserNotifications: true },
    );

    const updater = vi.fn((current) => current);
    mocks.setQueryData.mockImplementation((_key, update) => {
      if (typeof update === 'function') updater(update(previous));
    });
    mutationOptions.onError!(
      new Error('nope') as never,
      variables as never,
      context as never,
    );

    expect(updater).toHaveBeenCalledWith(previous);
    expect(mocks.toastError).toHaveBeenCalledWith('Save failed');
  });
});
