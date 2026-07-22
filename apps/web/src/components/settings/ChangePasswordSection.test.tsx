import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

const { changePasswordMock } = vi.hoisted(() => ({
  changePasswordMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    changePassword: changePasswordMock,
  },
}));

import { ChangePasswordSection } from './ChangePasswordSection';

describe('ChangePasswordSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    changePasswordMock.mockResolvedValue({
      data: { status: true },
      error: null,
    });
  });

  it('opens a password form with strength and confirmation indicators', () => {
    render(<ChangePasswordSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    expect(screen.getByLabelText('Password strength')).toBeInTheDocument();
    expect(screen.getByLabelText('Input match')).toBeInTheDocument();
  });

  it('changes the password through Better Auth and revokes other sessions', async () => {
    render(<ChangePasswordSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));

    await waitFor(() => {
      expect(changePasswordMock).toHaveBeenCalledWith({
        currentPassword: 'current-password',
        newPassword: 'new-password',
        revokeOtherSessions: true,
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Password changed.');
  });

  it('requires matching passwords before calling Better Auth', () => {
    render(<ChangePasswordSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'different-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));

    expect(toast.error).toHaveBeenCalledWith('Passwords do not match.');
    expect(changePasswordMock).not.toHaveBeenCalled();
  });
});
