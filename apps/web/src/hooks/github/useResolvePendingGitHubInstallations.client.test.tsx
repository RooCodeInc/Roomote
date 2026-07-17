import { renderHook } from '@testing-library/react';

const {
  invalidateQueriesMock,
  resolvePendingInstallationsMock,
  mutationOptionsRef,
  queryKeys,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  resolvePendingInstallationsMock: vi.fn(),
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
    pendingInstallations: ['github.pendingInstallations'],
    githubInstallations: ['github.installations'],
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
    github: {
      pendingInstallations: {
        queryKey: () => queryKeys.pendingInstallations,
      },
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
      resolvePendingInstallations: {
        mutate: resolvePendingInstallationsMock,
      },
    },
  }),
}));

import { useResolvePendingGitHubInstallations } from './useResolvePendingGitHubInstallations';

describe('useResolvePendingGitHubInstallations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePendingInstallationsMock.mockResolvedValue({
      success: true,
      pending: 0,
      completed: 1,
    });
  });

  it('invalidates the pending, installation, and repository queries before caller success handling', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useResolvePendingGitHubInstallations({ onSuccess }),
    );

    await result.current.mutateAsync();

    expect(resolvePendingInstallationsMock).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.pendingInstallations,
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.githubInstallations,
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.sourceControlRepositories,
    });
    // The caller-supplied onSuccess must still run — the internal wrapper must
    // not be clobbered by spreading caller options over it.
    expect(onSuccess).toHaveBeenCalledWith(
      { success: true, pending: 0, completed: 1 },
      undefined,
      undefined,
      undefined,
    );
    expect(invalidateQueriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      onSuccess.mock.invocationCallOrder[0]!,
    );
  });
});
