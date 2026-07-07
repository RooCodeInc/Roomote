import { renderHook } from '@testing-library/react';

const {
  invalidateQueriesMock,
  mutationOptionsRef,
  syncRepositoriesMock,
  queryKeys,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  syncRepositoriesMock: vi.fn(),
  mutationOptionsRef: {
    current: null as {
      mutationFn: () => Promise<unknown>;
      onSuccess?: (
        data: unknown,
        variables: void,
        onMutateResult: unknown,
        context: unknown,
      ) => void;
    } | null,
  },
  queryKeys: {
    sourceControlRepositories: ['sourceControl.repositories'],
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof mutationOptionsRef.current) => {
    mutationOptionsRef.current = options;

    return {
      mutateAsync: async () => {
        const data = await options?.mutationFn();
        options?.onSuccess?.(data, undefined, undefined, undefined);
        return data;
      },
      isPending: false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sourceControl: {
      repositories: {
        queryKey: () => queryKeys.sourceControlRepositories,
      },
    },
  }),
  useTRPCClient: () => ({
    sourceControl: {
      syncRepositories: {
        mutate: syncRepositoriesMock,
      },
    },
  }),
}));

import { useSyncRepositories } from './useSyncRepositories';

describe('useSyncRepositories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncRepositoriesMock.mockResolvedValue({
      success: true,
      repositories: [{ id: 'repo-1' }],
    });
  });

  it.each([['gitlab'], ['gitea'], ['ado']] as const)(
    'syncs %s repositories and invalidates the shared repository query',
    async (provider) => {
      const onSuccess = vi.fn();
      const { result } = renderHook(() =>
        useSyncRepositories(provider, { onSuccess }),
      );

      await result.current.mutateAsync();

      expect(syncRepositoriesMock).toHaveBeenCalledWith({ provider });
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: queryKeys.sourceControlRepositories,
      });
      expect(onSuccess).toHaveBeenCalledWith(
        { success: true, repositories: [{ id: 'repo-1' }] },
        undefined,
        undefined,
        undefined,
      );
    },
  );
});
