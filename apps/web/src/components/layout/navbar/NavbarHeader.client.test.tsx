import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ImgHTMLAttributes,
  ReactNode,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  setOpen: vi.fn(),
  user: {},
  drawerSetupIncomplete: false,
}));

vi.mock('next/image', () => ({
  default: ({
    priority: _priority,
    ...props
  }: ImgHTMLAttributes<HTMLImageElement> & {
    priority?: boolean;
  }) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} />;
  },
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

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Plus: () => <svg aria-hidden="true" />,
  Search: () => <svg aria-hidden="true" />,
}));

vi.mock('@/components/layout/CommandPaletteContext', () => ({
  useCommandPalette: () => ({
    setOpen: state.setOpen,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => state.user,
}));

vi.mock('../UserMenu', () => ({
  UserMenu: () => <div>UserMenu</div>,
}));

vi.mock('@/components/tasks/NewTaskDialog', () => ({
  NewTaskDialog: ({ open }: { open: boolean }) => (
    <div data-testid="new-task-dialog" data-open={String(open)} />
  ),
}));

vi.mock('./NavbarDrawer', () => ({
  NavbarDrawer: ({ setupIncomplete }: { setupIncomplete?: boolean }) => {
    state.drawerSetupIncomplete = setupIncomplete ?? false;
    return <div>NavbarDrawer</div>;
  },
}));

import { NavbarHeader } from './NavbarHeader';

describe('NavbarHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.drawerSetupIncomplete = false;
  });

  it('disables Home and passes incomplete setup state to the drawer', () => {
    render(<NavbarHeader setupIncomplete />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByAltText('Roomote')).toHaveClass('opacity-50');
    expect(state.drawerSetupIncomplete).toBe(true);
  });

  it('renders the current Roomote mark in the mobile header', () => {
    render(<NavbarHeader />);

    expect(screen.getByRole('link')).toHaveAttribute('href', '/');
    expect(screen.getByAltText('Roomote')).toHaveAttribute(
      'src',
      '/logos/r.svg',
    );
  });

  it('opens the command palette from the mobile search button', () => {
    render(<NavbarHeader />);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(state.setOpen).toHaveBeenCalledWith(true);
  });

  it('opens a new session dialog from beside the mobile logo', () => {
    render(<NavbarHeader />);

    const logo = screen.getByAltText('Roomote');
    const newSessionButton = screen.getByRole('button', {
      name: 'New Session',
    });

    expect(logo.compareDocumentPosition(newSessionButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(newSessionButton);

    expect(screen.getByTestId('new-task-dialog')).toHaveAttribute(
      'data-open',
      'true',
    );
  });
});
