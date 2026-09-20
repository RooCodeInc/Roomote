import { fireEvent, render, screen } from '@testing-library/react';

import SessionDetailError from './error';

describe('SessionDetailError', () => {
  it('retries the failed route in place', () => {
    const reset = vi.fn();

    render(<SessionDetailError reset={reset} />);

    expect(screen.getByText('Unable to load this session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
