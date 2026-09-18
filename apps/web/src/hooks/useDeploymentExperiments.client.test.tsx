import { act, renderHook } from '@testing-library/react';

import { getDeploymentExperimentValues } from '@roomote/feature-flags';

const { mocks, queryState } = vi.hoisted(() => ({
  mocks: {
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    mutate: vi.fn(),
    refetch: vi.fn(),
    setQueryData: vi.fn(),
    toastError: vi.fn(),
  },
  queryState: {
    data: undefined as
      | ReturnType<typeof getDeploymentExperimentValues>
      | undefined,
    error: null as Error | null,
    isFetching: false,
    isPending: true,
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

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    deploymentExperiments: {
      get: {
        queryKey: () => ['deployment-experiments'],
        queryOptions: () => ({}),
      },
      set: { mutationOptions: (options: unknown) => options },
    },
  }),
}));

import {
  useDeploymentExperiment,
  useDeploymentExperiments,
} from './useDeploymentExperiments';

describe('useDeploymentExperiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.data = getDeploymentExperimentValues(undefined);
    queryState.error = null;
    queryState.isFetching = false;
    queryState.isPending = false;
  });

  it('exposes the same shared value to every consumer hook', () => {
    queryState.data = {
      ...getDeploymentExperimentValues(undefined),
      results: true,
    };

    const first = renderHook(() => useDeploymentExperiment('results', 'fail'));
    const second = renderHook(() => useDeploymentExperiment('results', 'fail'));

    expect(first.result.current.enabled).toBe(true);
    expect(second.result.current.enabled).toBe(true);
  });

  it('sends one deployment experiment mutation', () => {
    const { result } = renderHook(() => useDeploymentExperiments());

    act(() => result.current.setExperiment('results', true));

    expect(mocks.mutate).toHaveBeenCalledWith({ id: 'results', enabled: true });
  });

  it('optimistically updates and rolls back only the changed deployment flag', async () => {
    const previous = getDeploymentExperimentValues(undefined);
    mocks.getQueryData.mockReturnValue(previous);
    renderHook(() => useDeploymentExperiments('Save failed'));

    const variables = {
      id: 'slackPeerConversations',
      enabled: true,
    } as const;
    const context = await mutationOptions.onMutate!(variables as never);

    expect(mocks.setQueryData).toHaveBeenCalledWith(
      ['deployment-experiments'],
      { ...previous, slackPeerConversations: true },
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
