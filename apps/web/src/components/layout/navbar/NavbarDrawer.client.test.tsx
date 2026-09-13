import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from 'react';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  pathname: '/',
  recentSessionsEnabled: false,
  user: {
    isAdmin: true,
  },
}));

function Icon() {
  return <svg aria-hidden="true" />;
}

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: () => true,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === 'string' ? href : '#'} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => state.user,
}));

vi.mock('@/hooks/useResultsPage', () => ({
  useResultsPage: () => ({ enabled: false, isLoading: false }),
}));

vi.mock('@/components/layout/side-nav/RecentSessions', () => ({
  RecentSessions: ({ enabled }: { enabled: boolean }) => {
    state.recentSessionsEnabled = enabled;
    return (
      <section>
        <h3>Recent sessions</h3>
      </section>
    );
  },
}));

vi.mock('@/components/system', () => ({
  Menu: Icon,
  X: Icon,
  House: Icon,
  Rows4: Icon,
  NotepadText: Icon,
  GalleryVerticalEnd: Icon,
  ChartColumnIncreasing: Icon,
  Lightbulb: Icon,
  Settings: Icon,
  Zap: Icon,
  Button: ({
    children,
    asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    children: ReactNode;
  }) =>
    asChild ? (
      children
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  Drawer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { NavbarDrawer } from './NavbarDrawer';

describe('NavbarDrawer', () => {
  beforeEach(() => {
    state.user.isAdmin = true;
    state.recentSessionsEnabled = false;
  });

  it('shows a settings link for members', () => {
    render(<NavbarDrawer />);

    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('keeps settings as the only admin/navigation destination in the drawer', () => {
    render(<NavbarDrawer />);

    expect(
      screen
        .getAllByRole('link')
        .map((link) => link.textContent?.trim())
        .filter(Boolean),
    ).toEqual(['Home', 'Sessions', 'Automations', 'Analytics', 'Settings']);
    expect(
      screen.queryByRole('button', { name: /support/i }),
    ).not.toBeInTheDocument();
  });

  it('shows recent sessions below the navigation options', () => {
    render(<NavbarDrawer />);

    const settings = screen.getByRole('link', { name: /settings/i });
    const recentSessions = screen.getByRole('heading', {
      name: 'Recent sessions',
    });

    expect(settings.compareDocumentPosition(recentSessions)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(state.recentSessionsEnabled).toBe(true);
  });

  it('keeps setup-gated destinations visible but disabled with an explanation', () => {
    render(<NavbarDrawer setupIncomplete />);

    expect(screen.getByRole('link', { name: 'Sessions' })).toHaveAttribute(
      'href',
      '/sessions',
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    for (const name of ['Home', 'Automations', 'Analytics']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(
      screen.getAllByText('Available when setup is completed.'),
    ).toHaveLength(3);
  });

  it('hides analytics from non-admins', () => {
    state.user.isAdmin = false;

    render(<NavbarDrawer />);

    expect(
      screen.queryByRole('link', { name: /analytics/i }),
    ).not.toBeInTheDocument();
  });

  it('shows automations to members', () => {
    state.user.isAdmin = false;

    render(<NavbarDrawer />);

    expect(screen.getByRole('link', { name: /automations/i })).toHaveAttribute(
      'href',
      '/automations',
    );
  });
});
