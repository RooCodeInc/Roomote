import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/system', () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    onValueChange,
    ...props
  }: ComponentPropsWithoutRef<'input'> & {
    onValueChange: (value: string) => void;
  }) => (
    <input
      {...props}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    />
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { CommandSearch } from './CommandSearch';

describe('CommandSearch', () => {
  it('lists packaged skills and selects their slash invocation', () => {
    const onOpenChange = vi.fn();
    const onSelectCommand = vi.fn();

    render(
      <CommandSearch
        open={true}
        onOpenChange={onOpenChange}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search commands...'), {
      target: { value: 'implement-changes' },
    });
    fireEvent.click(screen.getByText('/implement-changes'));

    expect(onSelectCommand).toHaveBeenCalledWith('/implement-changes');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
