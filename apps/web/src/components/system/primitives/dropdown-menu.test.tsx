import { render, screen } from '@testing-library/react';

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
});
