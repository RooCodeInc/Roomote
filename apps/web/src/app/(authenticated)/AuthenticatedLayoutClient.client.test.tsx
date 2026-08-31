import { render, screen, waitFor } from '@testing-library/react';

const { replaceMock, useQueryMock, useUserMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  useQueryMock: vi.fn(),
  useUserMock: vi.fn(),
}));

let mockPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: useUserMock,
  useUser: useUserMock,
}));

vi.mock('@/hooks/useSignInRedirect', () => ({
  useRedirectToSignIn: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    onboarding: {
      status: {
        queryOptions: vi.fn(() => ({ queryKey: ['onboarding.status'] })),
      },
    },
    setup: {
      status: {
        queryOptions: vi.fn(() => ({ queryKey: ['setup.status'] })),
      },
      sessionStatus: {
        queryOptions: vi.fn(() => ({ queryKey: ['setup.sessionStatus'] })),
      },
    },
  }),
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

import AuthenticatedLayoutClient from './AuthenticatedLayoutClient';

describe('AuthenticatedLayoutClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    useUserMock.mockReturnValue({
      authStatus: 'signed-in',
      isSignedIn: true,
      user: { isAdmin: true },
    });
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => ({
      data:
        options.queryKey[0] === 'setup.sessionStatus'
          ? { sessionId: null, completed: false }
          : {
              hasGitHub: true,
              hasEnvironments: true,
              setupCompletedAt: '2026-01-01T00:00:00.000Z',
            },
      isLoading: false,
      isError: false,
    }));
  });

  it('renders authenticated pages when setup is complete', () => {
    const { container } = render(
      <AuthenticatedLayoutClient>
        <div>Home content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.getByText('Home content')).toBeVisible();
    expect(
      container.querySelector('.h-effective-viewport'),
    ).toBeInTheDocument();
    expect(container.querySelector('.h-viewport')).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects incomplete admins to setup before rendering the page', async () => {
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => ({
      data:
        options.queryKey[0] === 'setup.sessionStatus'
          ? { sessionId: null, completed: false }
          : {
              hasGitHub: false,
              hasEnvironments: false,
              setupCompletedAt: null,
            },
      isLoading: false,
      isError: false,
    }));

    render(
      <AuthenticatedLayoutClient>
        <div>Home content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.queryByText('Home content')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/setup?step=welcome');
    });
  });

  it('redirects incomplete admins to their persisted setup Session', async () => {
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => ({
      data:
        options.queryKey[0] === 'setup.sessionStatus'
          ? { sessionId: 'setup-session-id', completed: false }
          : {
              hasGitHub: false,
              hasEnvironments: false,
              setupCompletedAt: null,
            },
      isLoading: false,
      isError: false,
    }));

    render(
      <AuthenticatedLayoutClient>
        <div>Home content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.queryByText('Home content')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/sessions/setup-session-id');
    });
  });

  it('waits for the setup-session lookup before redirecting an incomplete admin', () => {
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => ({
      data:
        options.queryKey[0] === 'setup.sessionStatus'
          ? undefined
          : {
              hasGitHub: false,
              hasEnvironments: false,
              setupCompletedAt: null,
            },
      isLoading: options.queryKey[0] === 'setup.sessionStatus',
      isError: false,
    }));

    render(
      <AuthenticatedLayoutClient>
        <div>Home content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.getByText('Home content')).toBeVisible();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders authenticated pages when setup is complete but environments are still missing', () => {
    mockPathname = '/settings/previews';
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => ({
      data:
        options.queryKey[0] === 'setup.sessionStatus'
          ? { sessionId: null, completed: false }
          : {
              hasGitHub: true,
              hasEnvironments: false,
              setupCompletedAt: '2026-01-01T00:00:00.000Z',
            },
      isLoading: false,
      isError: false,
    }));

    render(
      <AuthenticatedLayoutClient>
        <div>Settings content</div>
      </AuthenticatedLayoutClient>,
    );

    expect(screen.getByText('Settings content')).toBeVisible();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
