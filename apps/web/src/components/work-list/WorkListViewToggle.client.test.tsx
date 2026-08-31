import { fireEvent, render, screen } from '@testing-library/react';

import { WorkListViewToggle } from './WorkListViewToggle';

describe('WorkListViewToggle', () => {
  it('exposes the selected view and changes views through labelled buttons', () => {
    const onChange = vi.fn();

    render(<WorkListViewToggle view="list" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Board view' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Board view' }));

    expect(onChange).toHaveBeenCalledWith('board');
  });
});
