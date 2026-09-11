import { renderHook } from '@testing-library/react';

const { sendVerificationEmail, mutationOptionsRef } = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
  mutationOptionsRef: {
    current: null as {
      mutationFn: (email: string) => Promise<void>;
    } | null,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: typeof mutationOptionsRef.current) => {
    mutationOptionsRef.current = options;
    return {
      mutateAsync: async (email: string) => options?.mutationFn(email),
      isPending: false,
    };
  },
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: { sendVerificationEmail },
}));

import { useResendEmailVerification } from './useResendEmailVerification';

describe('useResendEmailVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses Better Auth verification with the personal settings callback', async () => {
    sendVerificationEmail.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    const { result } = renderHook(() => useResendEmailVerification());

    await result.current.mutateAsync('login@example.com');

    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: 'login@example.com',
      callbackURL: '/settings/personal',
    });
  });

  it('turns Better Auth response errors into mutation errors', async () => {
    sendVerificationEmail.mockResolvedValue({
      data: null,
      error: { message: 'Too many requests' },
    });
    const { result } = renderHook(() => useResendEmailVerification());

    await expect(
      result.current.mutateAsync('login@example.com'),
    ).rejects.toThrow('Too many requests');
  });
});
