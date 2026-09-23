import { render, screen } from '@testing-library/react';

const { redirectToSignInMock, useUserMock } = vi.hoisted(() => ({
  redirectToSignInMock: vi.fn(),
  useUserMock: vi.fn(),
}));

vi.mock('@/hooks/useUser', () => ({ useUser: useUserMock }));
vi.mock('@/hooks/useSignInRedirect', () => ({
  useRedirectToSignIn: redirectToSignInMock,
}));

vi.mock('@/components/layout', () => ({
  FramedSurface: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  NavbarHeader: () => <div>Navbar</div>,
  SideNav: () => <div>Side nav</div>,
}));

vi.mock('@/components/layout/CommandPaletteContext', () => ({
  CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/layout/CommandPalette', () => ({
  CommandPalette: () => <div>Command palette</div>,
}));

vi.mock('@/components/layout/McpOAuthResultFeedback', () => ({
  McpOAuthResultFeedback: () => null,
}));
vi.mock('./ManagedAccessBanner', () => ({ ManagedAccessBanner: () => null }));

import AuthenticatedLayoutClient from './AuthenticatedLayoutClient';

describe('AuthenticatedLayoutClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserMock.mockReturnValue({
      authStatus: 'signed-in',
      isSignedIn: true,
      user: { isAdmin: true },
    });
  });

  it('renders dashboard pages for admins before first-run setup is complete', () => {
    const { container } = render(
      <AuthenticatedLayoutClient>
        <div>Dashboard content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.getByText('Dashboard content')).toBeVisible();
    expect(
      container.querySelector('.h-effective-viewport'),
    ).toBeInTheDocument();
    expect(redirectToSignInMock).toHaveBeenCalledWith(false);
  });

  it('renders dashboard pages for members before personal onboarding is complete', () => {
    useUserMock.mockReturnValue({
      authStatus: 'signed-in',
      isSignedIn: true,
      user: { isAdmin: false },
    });

    render(
      <AuthenticatedLayoutClient>
        <div>Dashboard content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.getByText('Dashboard content')).toBeVisible();
    expect(redirectToSignInMock).toHaveBeenCalledWith(false);
  });

  it('continues to redirect signed-out visitors', () => {
    useUserMock.mockReturnValue({
      authStatus: 'signed-out',
      isSignedIn: false,
      user: null,
    });

    render(
      <AuthenticatedLayoutClient>
        <div>Dashboard content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.queryByText('Dashboard content')).not.toBeInTheDocument();
    expect(redirectToSignInMock).toHaveBeenCalledWith(true);
  });
});
