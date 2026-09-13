import { fireEvent, render, screen } from '@testing-library/react';

import { TaskCardError } from './TaskCardError';

describe('TaskCardError', () => {
  it('lets the user retry loading tasks', () => {
    const onRetry = vi.fn();

    render(<TaskCardError onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
