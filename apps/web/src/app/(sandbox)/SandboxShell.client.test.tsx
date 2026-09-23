import { render, screen } from '@testing-library/react';

const { redirectToSignInMock, useUserMock } = vi.hoisted(() => ({
  redirectToSignInMock: vi.fn(),
  useUserMock: vi.fn(),
}));

vi.mock('@/hooks/useUser', () => ({ useUser: useUserMock }));
vi.mock('@/hooks/useSignInRedirect', () => ({
  useRedirectToSignIn: redirectToSignInMock,
}));
vi.mock('@/hooks/useSessionNavigationState', () => ({
  SessionNavigationStateProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div>{children}</div>,
}));
vi.mock('@/lib', () => ({ zIndex: () => '' }));
vi.mock('@/components/layout', () => ({
  Logo: () => <div>Logo</div>,
  NavbarHeader: () => <div>Navbar</div>,
  SideNav: () => <div>Side nav</div>,
}));
vi.mock('@/components/system', () => ({
  Spinner: () => <div>Spinner</div>,
}));

import { SandboxShell } from './SandboxShell';

describe('SandboxShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserMock.mockReturnValue({
      authStatus: 'signed-in',
      isSignedIn: true,
      user: { isAdmin: true },
    });
  });

  it('keeps session pages available to admins before setup completion', () => {
    render(
      <SandboxShell>
        <div>Session content</div>
      </SandboxShell>,
    );

    expect(screen.getByText('Session content')).toBeVisible();
    expect(redirectToSignInMock).toHaveBeenCalledWith(false);
  });

  it('keeps session pages available to members before onboarding completion', () => {
    useUserMock.mockReturnValue({
      authStatus: 'signed-in',
      isSignedIn: true,
      user: { isAdmin: false },
    });

    render(
      <SandboxShell>
        <div>Session content</div>
      </SandboxShell>,
    );

    expect(screen.getByText('Session content')).toBeVisible();
    expect(redirectToSignInMock).toHaveBeenCalledWith(false);
  });

  it('continues to redirect signed-out visitors', () => {
    useUserMock.mockReturnValue({
      authStatus: 'signed-out',
      isSignedIn: false,
      user: null,
    });

    render(
      <SandboxShell>
        <div>Session content</div>
      </SandboxShell>,
    );

    expect(screen.queryByText('Session content')).not.toBeInTheDocument();
    expect(screen.getByText('Spinner')).toBeVisible();
    expect(redirectToSignInMock).toHaveBeenCalledWith(true);
  });
});
