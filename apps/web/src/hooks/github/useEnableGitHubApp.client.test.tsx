import { renderHook } from '@testing-library/react';

const { enableAppMock, mutationOptionsRef, invalidateQueriesMock, queryKeys } =
  vi.hoisted(() => ({
    enableAppMock: vi.fn(),
    mutationOptionsRef: {
      current: null as {
        mutationFn: (variables: unknown) => Promise<unknown>;
        onSuccess?: (
          data: unknown,
          variables: unknown,
          onMutateResult: unknown,
          context: unknown,
        ) => void;
      } | null,
    },
    invalidateQueriesMock: vi.fn(),
    queryKeys: {
      githubInstallations: ['github.installations'],
      sourceControlRepositories: ['sourceControl.repositories'],
    },
  }));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof mutationOptionsRef.current) => {
    mutationOptionsRef.current = options;

    return {
      mutateAsync: async (variables: unknown) => {
        const data = await options?.mutationFn(variables);
        options?.onSuccess?.(data, variables, undefined, undefined);
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
      enableApp: {
        mutate: enableAppMock,
      },
    },
  }),
}));

import { useEnableGitHubApp } from './useEnableGitHubApp';

describe('useEnableGitHubApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableAppMock.mockResolvedValue({
      success: true,
      mode: 'redirect',
      url: 'https://github.example/install',
    });
  });

  it('returns the GitHub app result for legacy redirect string inputs', async () => {
    const { result } = renderHook(() => useEnableGitHubApp());

    await expect(result.current.mutateAsync('/settings')).resolves.toEqual({
      success: true,
      mode: 'redirect',
      url: 'https://github.example/install',
    });

    expect(enableAppMock).toHaveBeenCalledWith({
      state: { redirect: '/settings' },
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.githubInstallations,
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.sourceControlRepositories,
    });
  });

  it('includes callback background for settings-originated GitHub app updates', async () => {
    const { result } = renderHook(() => useEnableGitHubApp());

    await expect(
      result.current.mutateAsync({
        redirect: '/settings/environments/new?add-mcp=pylon',
        callbackBackground: 'background',
      }),
    ).resolves.toEqual({
      success: true,
      mode: 'redirect',
      url: 'https://github.example/install',
    });

    expect(enableAppMock).toHaveBeenCalledWith({
      state: {
        redirect: '/settings/environments/new?add-mcp=pylon',
        bg: 'background',
      },
    });
  });
});
