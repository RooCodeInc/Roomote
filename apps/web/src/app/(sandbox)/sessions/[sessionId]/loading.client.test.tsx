import { render, screen } from '@testing-library/react';

import LoadingSession from './loading';

describe('Session route loading state', () => {
  it('provides immediate, accessible navigation feedback', () => {
    render(<LoadingSession />);

    expect(
      screen.getByRole('status', { name: 'Loading session' }),
    ).toBeInTheDocument();
  });
});
