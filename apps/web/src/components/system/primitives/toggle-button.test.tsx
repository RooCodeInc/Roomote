import { fireEvent, render, screen } from '@testing-library/react';

import { ToggleButton } from './toggle-button';

describe('ToggleButton', () => {
  it('toggles its pressed state', () => {
    render(<ToggleButton aria-label="List view">List</ToggleButton>);

    const toggle = screen.getByRole('button', { name: 'List view' });

    expect(toggle).toHaveAttribute('data-slot', 'toggle-button');
    expect(toggle).toHaveAttribute('data-state', 'off');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('data-state', 'on');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports controlled changes without changing its controlled state', () => {
    const onPressedChange = vi.fn();

    render(
      <ToggleButton pressed={false} onPressedChange={onPressedChange}>
        Board
      </ToggleButton>,
    );

    const toggle = screen.getByRole('button', { name: 'Board' });
    fireEvent.click(toggle);

    expect(onPressedChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute('data-state', 'off');
  });
});
