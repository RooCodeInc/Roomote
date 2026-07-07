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
}));

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => {
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

vi.mock('./NavbarDrawer', () => ({
  NavbarDrawer: () => <div>NavbarDrawer</div>,
}));

import { NavbarHeader } from './NavbarHeader';

describe('NavbarHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
