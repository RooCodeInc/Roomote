import { renderHook } from '@testing-library/react';

const {
  invalidateQueriesMock,
  removeQueriesMock,
  syncInstallationMock,
  mutationOptionsRef,
  queryKeys,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  removeQueriesMock: vi.fn(),
  syncInstallationMock: vi.fn(),
  mutationOptionsRef: {
    current: null as {
      mutationFn: (variables: number) => Promise<unknown>;
      onSuccess?: (
        data: unknown,
        variables: number,
        onMutateResult: unknown,
        context: unknown,
      ) => void;
    } | null,
  },
  queryKeys: {
    setupStatus: ['setup.status'],
    githubInstallations: ['github.installations'],
    sourceControlRepositories: ['sourceControl.repositories'],
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof mutationOptionsRef.current) => {
    mutationOptionsRef.current = options;

    return {
      mutateAsync: async (variables: number) => {
        const data = await options?.mutationFn(variables);
        options?.onSuccess?.(data, variables, undefined, undefined);
        return data;
      },
      isPending: false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
    removeQueries: removeQueriesMock,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      status: {
        queryKey: () => queryKeys.setupStatus,
      },
    },
    github: {
      installations: {
        queryKey: () => queryKeys.githubInstallations,
      },
    },
    sourceControl: {
      repositories: {
        queryKey: () => queryKeys.sourceControlRepositories,
      },
    },
  }),
  useTRPCClient: () => ({
    github: {
      syncInstallation: {
        mutate: syncInstallationMock,
      },
    },
  }),
}));

import { useSyncGitHubInstallation } from './useSyncGitHubInstallation';

describe('useSyncGitHubInstallation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncInstallationMock.mockResolvedValue({ success: true });
  });

  it('clears setup status and invalidates GitHub queries before running caller success handling', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useSyncGitHubInstallation({ onSuccess }),
    );

    await result.current.mutateAsync(123);

    expect(syncInstallationMock).toHaveBeenCalledWith({ installationId: 123 });
    expect(removeQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.setupStatus,
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.githubInstallations,
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.sourceControlRepositories,
    });
    expect(onSuccess).toHaveBeenCalledWith(
      { success: true },
      123,
      undefined,
      undefined,
    );
    expect(removeQueriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      onSuccess.mock.invocationCallOrder[0]!,
    );
  });
});
