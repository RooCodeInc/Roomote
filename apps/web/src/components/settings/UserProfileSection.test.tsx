import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

const { changeEmailMock, changePasswordMock, updateUserMock } = vi.hoisted(
  () => ({
    changeEmailMock: vi.fn(),
    changePasswordMock: vi.fn(),
    updateUserMock: vi.fn(),
  }),
);

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    changeEmail: changeEmailMock,
    changePassword: changePasswordMock,
    updateUser: updateUserMock,
  },
}));

const routerRefreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}));

vi.mock('./Section', () => ({
  Section: ({
    action,
    title,
    children,
  }: {
    action?: ReactNode;
    title: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  ),
}));

import { UserProfileSection } from './UserProfileSection';

describe('UserProfileSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    changeEmailMock.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    changePasswordMock.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    updateUserMock.mockResolvedValue({
      data: { status: true },
      error: null,
    });
  });

  it('renders the signed-in user profile instead of the local admin placeholder', () => {
    render(
      <UserProfileSection
        profile={{
          email: 'matt@example.com',
          imageUrl: '',
          name: 'Matt User',
        }}
      />,
    );

    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('Matt User')).toBeInTheDocument();
    expect(screen.getByText('matt@example.com')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Deployment operator')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Local Roomote uses the built-in administrator account.',
      ),
    ).not.toBeInTheDocument();
  });

  it('shows the provider image when available', () => {
    render(
      <UserProfileSection
        profile={{
          email: 'teammate@example.com',
          imageUrl: 'https://example.com/avatar.png',
          name: 'Teammate',
        }}
      />,
    );

    expect(screen.getByText('Teammate')).toBeInTheDocument();
    const avatar = screen.getByLabelText('Teammate');
    const image = avatar.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute('src', 'https://example.com/avatar.png');
    expect(image).toHaveAttribute('alt', '');
  });

  it('shows credential details and expands the edit form for credential users', () => {
    render(
      <UserProfileSection
        canChangePassword={true}
        profile={{
          email: 'matt@example.com',
          imageUrl: '',
          name: 'Matt User',
        }}
      />,
    );

    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveTextContent('••••••••');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Matt User');
    expect(screen.getByLabelText('Email')).toHaveValue('matt@example.com');
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
  });

  it('updates name, email, and password from the expanded profile form', async () => {
    render(
      <UserProfileSection
        canChangePassword={true}
        profile={{
          email: 'matt@example.com',
          imageUrl: '',
          name: 'Matt User',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New Name' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateUserMock).toHaveBeenCalledWith({ name: 'New Name' });
      expect(changeEmailMock).toHaveBeenCalledWith({
        newEmail: 'new@example.com',
      });
    });
    expect(changePasswordMock).toHaveBeenCalledWith({
      currentPassword: 'current-password',
      newPassword: 'new-password',
      revokeOtherSessions: true,
    });
    expect(toast.success).toHaveBeenCalledWith('Profile updated.');
    expect(routerRefreshMock).toHaveBeenCalled();
  });

  it('requires a non-blank name before updating the profile', () => {
    render(
      <UserProfileSection
        canChangePassword={true}
        profile={{
          email: 'matt@example.com',
          imageUrl: '',
          name: 'Matt User',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(toast.error).toHaveBeenCalledWith('Enter your name.');
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('refreshes the profile after a name update when email changes fail', async () => {
    changeEmailMock.mockResolvedValue({
      data: null,
      error: { message: 'Email update failed' },
    });

    render(
      <UserProfileSection
        canChangePassword={true}
        profile={{
          email: 'matt@example.com',
          imageUrl: '',
          name: 'Matt User',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New Name' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(routerRefreshMock).toHaveBeenCalled();
    });
    expect(toast.error).toHaveBeenCalledWith('Email update failed');
  });

  it('validates matching passwords before updating credentials', () => {
    render(
      <UserProfileSection
        canChangePassword={true}
        profile={{
          email: 'matt@example.com',
          imageUrl: '',
          name: 'Matt User',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'different-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(toast.error).toHaveBeenCalledWith('Passwords do not match.');
    expect(changeEmailMock).not.toHaveBeenCalled();
    expect(changePasswordMock).not.toHaveBeenCalled();
  });
});
