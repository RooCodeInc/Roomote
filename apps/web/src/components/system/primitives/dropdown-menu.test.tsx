import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

describe('DropdownMenuItem', () => {
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
});
