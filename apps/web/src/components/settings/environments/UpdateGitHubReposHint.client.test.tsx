import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockEnableGitHubApp, mockUserState, mockNavigationState, mockToast } =
  vi.hoisted(() => {
    return {
      mockEnableGitHubApp: vi.fn(),
      mockUserState: { isAdmin: true as boolean },
      mockNavigationState: {
        pathname: '/settings/environments/new',
        search: '' as string,
      },
      mockToast: {
        error: vi.fn(),
        success: vi.fn(),
      },
    };
  });

vi.mock('next/navigation', () => ({
  usePathname: () => mockNavigationState.pathname,
  useSearchParams: () => new URLSearchParams(mockNavigationState.search),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

vi.mock('@/hooks/github', () => ({
  useEnableGitHubApp: () => ({
    mutate: mockEnableGitHubApp,
    isPending: false,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: mockUserState.isAdmin }),
}));

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Pencil: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

import { UpdateGitHubReposHint } from './UpdateGitHubReposHint';

const originalLocation = window.location;

function setLocationHref(setter: (href: string) => void) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      ...originalLocation,
      set href(value: string) {
        setter(value);
      },
    } as unknown as Location & { href: string },
  });
}

describe('UpdateGitHubReposHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserState.isAdmin = true;
    mockNavigationState.pathname = '/settings/environments/new';
    mockNavigationState.search = '';
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('renders an admin update button that triggers the GitHub install redirect', async () => {
    const navigationTargets: string[] = [];
    setLocationHref((value) => navigationTargets.push(value));

    mockEnableGitHubApp.mockImplementation((_redirect, options) => {
      options.onSuccess(
        {
          success: true,
          mode: 'redirect',
          url: 'https://github.com/apps/roomote/installations/new',
        },
        _redirect,
        undefined,
        undefined,
      );
    });

    render(<UpdateGitHubReposHint />);

    fireEvent.click(screen.getByRole('button', { name: /Update GitHub/i }));

    await waitFor(() => {
      expect(mockEnableGitHubApp).toHaveBeenCalledWith(
        {
          redirect: '/settings/environments/new',
          callbackBackground: 'background',
        },
        expect.any(Object),
      );
    });

    expect(navigationTargets).toContain(
      'https://github.com/apps/roomote/installations/new',
    );
  });

  it('preserves the current query string in the redirect target', async () => {
    mockNavigationState.search = 'add-mcp=pylon';

    mockEnableGitHubApp.mockImplementation((_redirect, options) => {
      options.onSuccess(
        { success: true, mode: 'synced' },
        _redirect,
        undefined,
        undefined,
      );
    });

    render(<UpdateGitHubReposHint />);

    fireEvent.click(screen.getByRole('button', { name: /Update GitHub/i }));

    await waitFor(() => {
      expect(mockEnableGitHubApp).toHaveBeenCalledWith(
        {
          redirect: '/settings/environments/new?add-mcp=pylon',
          callbackBackground: 'background',
        },
        expect.any(Object),
      );
    });
  });

  it('shows a non-admin hint without a button when the user is not an admin', () => {
    mockUserState.isAdmin = false;

    render(<UpdateGitHubReposHint />);

    expect(screen.getByText(/Ask an admin/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Update GitHub/i }),
    ).not.toBeInTheDocument();
  });
});
