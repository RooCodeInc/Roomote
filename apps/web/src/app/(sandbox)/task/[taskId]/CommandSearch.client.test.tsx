import { fireEvent, render, screen } from '@testing-library/react';

import { CommandSearch } from './CommandSearch';

describe('CommandSearch', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('shows and selects the built-in goal command', () => {
    const onOpenChange = vi.fn();
    const onSelectCommand = vi.fn();

    render(
      <CommandSearch
        open
        onOpenChange={onOpenChange}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.click(screen.getByText('/goal'));

    expect(onSelectCommand).toHaveBeenCalledWith('/goal');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('filters the goal command by its description', () => {
    render(
      <CommandSearch open onOpenChange={() => {}} onSelectCommand={() => {}} />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search commands...'), {
      target: { value: 'multiple turns' },
    });

    expect(screen.getByText('/goal')).toBeInTheDocument();
  });
});
