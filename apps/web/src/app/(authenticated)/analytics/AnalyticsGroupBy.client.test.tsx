import { render, screen } from '@testing-library/react';

import { AnalyticsGroupBy } from './AnalyticsGroupBy';

describe('AnalyticsGroupBy', () => {
  it('renders a By select trigger with the active dimension label', () => {
    render(
      <AnalyticsGroupBy
        object="pullRequests"
        value="user"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'View by' });
    expect(trigger).toHaveTextContent('User');
  });
});
