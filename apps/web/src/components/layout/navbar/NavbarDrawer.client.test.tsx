import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from 'react';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  pathname: '/',
  user: {
    isAdmin: true,
    featureFlags: {},
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
    ).toEqual(['Home', 'Automations', 'Tasks', 'Analytics', 'Settings']);
    expect(
      screen.queryByRole('button', { name: /support/i }),
    ).not.toBeInTheDocument();
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
});
