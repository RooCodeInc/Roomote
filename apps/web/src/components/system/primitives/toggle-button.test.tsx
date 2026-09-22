import { fireEvent, render, screen } from '@testing-library/react';

import { ToggleButton } from './toggle-button';

describe('ToggleButton', () => {
  it('renders an accessible pressed button and preserves Button sizes', () => {
    render(
      <ToggleButton pressed size="sm" aria-label="Auto">
        Auto
      </ToggleButton>,
    );

    const button = screen.getByRole('button', { name: 'Auto' });

    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('data-state', 'on');
    expect(button).toHaveClass('h-8');
    expect(button).toHaveClass('text-sm');
  });

  it('supports controlled pressed changes with only ghost and outline styling', () => {
    const onPressedChange = vi.fn();
    render(
      <ToggleButton
        variant="outline"
        pressed={false}
        onPressedChange={onPressedChange}
        aria-label="Always allow"
      />,
    );

    const button = screen.getByRole('button', { name: 'Always allow' });
    expect(button).toHaveClass('border-foreground/40');

    fireEvent.click(button);
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });
});
