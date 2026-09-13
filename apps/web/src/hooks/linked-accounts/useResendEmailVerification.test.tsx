import { renderHook } from '@testing-library/react';

const { mutationOptions, mutationResult, useMutationMock } = vi.hoisted(() => ({
  mutationOptions: { mutationKey: ['resend-email-verification'] },
  mutationResult: { isPending: false, mutate: vi.fn() },
  useMutationMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: useMutationMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    linkedAccounts: {
      resendEmailVerification: {
        mutationOptions: () => mutationOptions,
      },
    },
  }),
}));

import { useResendEmailVerification } from './useResendEmailVerification';

describe('useResendEmailVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMutationMock.mockReturnValue(mutationResult);
  });

  it('uses the protected linked-account resend mutation', () => {
    const { result } = renderHook(() => useResendEmailVerification());

    expect(useMutationMock).toHaveBeenCalledWith(mutationOptions);
    expect(result.current).toBe(mutationResult);
  });
});
