import { fireEvent, render, screen } from '@testing-library/react';

import SessionDetailError from './error';

describe('SessionDetailError', () => {
  it('refetches the failed route through retry instead of only resetting', () => {
    const retry = vi.fn();
    const reset = vi.fn();

    render(
      <SessionDetailError
        {...({ error: new Error('boom'), reset, retry } as {
          retry: () => void;
        })}
      />,
    );

    expect(screen.getByText('Unable to load this session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });
});
