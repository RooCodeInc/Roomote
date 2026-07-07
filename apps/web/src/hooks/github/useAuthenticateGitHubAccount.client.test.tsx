import { renderHook } from '@testing-library/react';

const { startAuthenticateAccountMock, mutationOptionsRef } = vi.hoisted(() => ({
  startAuthenticateAccountMock: vi.fn(),
  mutationOptionsRef: {
    current: null as {
      mutationFn: (variables: unknown) => Promise<unknown>;
    } | null,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof mutationOptionsRef.current) => {
    mutationOptionsRef.current = options;

    return {
      mutateAsync: async (variables: unknown) => options?.mutationFn(variables),
      isPending: false,
    };
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    github: {
      startAuthenticateAccount: {
        mutate: startAuthenticateAccountMock,
      },
    },
  }),
}));

import { useAuthenticateGitHubAccount } from './useAuthenticateGitHubAccount';

describe('useAuthenticateGitHubAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startAuthenticateAccountMock.mockResolvedValue({
      success: true,
      url: 'https://github.example/auth',
    });
  });

  it('returns the GitHub auth result for legacy redirect string inputs', async () => {
    const { result } = renderHook(() => useAuthenticateGitHubAccount());

    await expect(
      result.current.mutateAsync('/settings/personal'),
    ).resolves.toEqual({
      success: true,
      url: 'https://github.example/auth',
    });

    expect(startAuthenticateAccountMock).toHaveBeenCalledWith({
      state: { redirect: '/settings/personal' },
    });
  });

  it('includes callback background state and returns the auth result', async () => {
    const { result } = renderHook(() => useAuthenticateGitHubAccount());

    await expect(
      result.current.mutateAsync({
        redirect: '/settings/personal?service=github',
        callbackBackground: 'background',
      }),
    ).resolves.toEqual({
      success: true,
      url: 'https://github.example/auth',
    });

    expect(startAuthenticateAccountMock).toHaveBeenCalledWith({
      state: {
        redirect: '/settings/personal?service=github',
        bg: 'background',
      },
    });
  });
});
