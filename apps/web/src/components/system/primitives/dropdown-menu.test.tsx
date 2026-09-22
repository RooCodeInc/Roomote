import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => state.isMobile,
}));

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

describe('DropdownMenuItem', () => {
  beforeEach(() => {
    state.isMobile = false;
  });

  it('uses the destructive focus treatment classes', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">Open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass(
      'data-[variant=destructive]:text-destructive',
      'data-[variant=destructive]:focus:bg-destructive',
      'data-[variant=destructive]:focus:text-white',
    );
  });

  it('lets mobile dropdown drawers override desktop max-width classes', () => {
    state.isMobile = true;

    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">Open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-w-64">
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(
      document.querySelector('[data-slot="dropdown-menu-content"]'),
    ).toHaveClass(
      'data-[vaul-drawer-direction=bottom]:w-full',
      'data-[vaul-drawer-direction=bottom]:max-w-none',
    );
  });

  it.each([false, true])(
    'keeps outside navigation accessible for non-modal menus (mobile: %s)',
    (isMobile) => {
      state.isMobile = isMobile;
      const navigate = vi.fn();
      render(
        <>
          <a
            href="/automations"
            onClick={(event) => {
              event.preventDefault();
              navigate();
            }}
          >
            Automations
          </a>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger asChild>
              <button>Filter</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>All sessions</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>,
      );

      expect(
        screen.getByRole('menuitem', { name: 'All sessions' }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('link', { name: 'Automations' }));
      expect(navigate).toHaveBeenCalledOnce();
    },
  );

  it('keeps ordinary mobile dropdowns modal', () => {
    state.isMobile = true;
    render(
      <>
        <a href="/automations">Automations</a>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild>
            <button>Open</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Automations' }),
    ).not.toBeInTheDocument();
  });
});
