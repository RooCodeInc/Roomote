import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  pathname: '/',
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

vi.mock('@/components/system', () => ({
  Menu: Icon,
  Plus: Icon,
  X: Icon,
  House: Icon,
  Rows4: Icon,
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
}));

vi.mock('@/components/tasks/NewTaskDialog', () => ({
  NewTaskDialog: ({ open }: { open: boolean }) => (
    <div data-testid="new-task-dialog" data-open={String(open)} />
  ),
}));

import { NavbarDrawer } from './NavbarDrawer';

describe('NavbarDrawer', () => {
  beforeEach(() => {
    state.user.isAdmin = true;
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

  it('opens a new session dialog from an action above Home', () => {
    render(<NavbarDrawer />);

    const newTaskButton = screen.getByRole('button', { name: 'New Session' });
    const homeLink = screen.getByRole('link', { name: 'Home' });

    expect(newTaskButton.compareDocumentPosition(homeLink)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(newTaskButton);

    expect(screen.getByTestId('new-task-dialog')).toHaveAttribute(
      'data-open',
      'true',
    );
  });

  it('hides analytics from non-admins', () => {
    state.user.isAdmin = false;

    render(<NavbarDrawer />);

    expect(
      screen.queryByRole('link', { name: /analytics/i }),
    ).not.toBeInTheDocument();
  });

  it('hides automations from non-admins', () => {
    state.user.isAdmin = false;

    render(<NavbarDrawer />);

    expect(
      screen.queryByRole('link', { name: /automations/i }),
    ).not.toBeInTheDocument();
  });

  it('hides gated destinations during setup while keeping Settings available', () => {
    render(<NavbarDrawer setupIncomplete />);

    expect(
      screen
        .getAllByRole('link')
        .map((link) => link.textContent?.trim())
        .filter(Boolean),
    ).toEqual(['Sessions', 'Settings']);
  });
});
