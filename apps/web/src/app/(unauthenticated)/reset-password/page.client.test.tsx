import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { replaceMock, refreshMock, resetPasswordMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  resetPasswordMock: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
    refresh: refreshMock,
  }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    resetPassword: resetPasswordMock,
  },
}));

import { ResetPasswordPageClient } from './page.client';

describe('ResetPasswordPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = new URLSearchParams('token=reset-token');
    resetPasswordMock.mockResolvedValue({
      data: { status: true },
      error: null,
    });
  });

  it('shows an invalid link state without a token', () => {
    searchParams = new URLSearchParams();

    render(<ResetPasswordPageClient />);

    expect(
      screen.getByText(/This reset link is invalid or expired/),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Back to sign in' }),
    ).toHaveAttribute('href', '/sign-in');
    expect(
      screen.queryByRole('button', { name: 'Reset password' }),
    ).not.toBeInTheDocument();
  });

  it('shows an invalid link state for BetterAuth invalid-token redirects', () => {
    searchParams = new URLSearchParams('error=INVALID_TOKEN');

    render(<ResetPasswordPageClient />);

    expect(
      screen.getByText(/This reset link is invalid or expired/),
    ).toBeVisible();
  });

  it('validates matching passwords before calling BetterAuth', async () => {
    render(<ResetPasswordPageClient />);

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'different-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Passwords do not match.')).toBeVisible();
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it('resets the password and redirects to sign in', async () => {
    render(<ResetPasswordPageClient />);

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(resetPasswordMock).toHaveBeenCalledWith({
        newPassword: 'new-password',
        token: 'reset-token',
      });
    });
    expect(replaceMock).toHaveBeenCalledWith('/sign-in?password_reset=1');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('shows BetterAuth reset errors', async () => {
    resetPasswordMock.mockResolvedValue({
      data: null,
      error: { message: 'Invalid token' },
    });

    render(<ResetPasswordPageClient />);

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Invalid token')).toBeVisible();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
