import { render, screen } from '@testing-library/react';

import { AnalyticsGranularitySelector } from './AnalyticsGranularitySelector';

describe('AnalyticsGranularitySelector', () => {
  it('renders the centered selector without a visible label', () => {
    render(
      <AnalyticsGranularitySelector
        value="week"
        availableGranularities={['day', 'week', 'month', 'year']}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Chart granularity' }),
    ).toBeInTheDocument();
    expect(screen.getByText('By Week')).toBeInTheDocument();
    expect(screen.queryByText('Granularity')).not.toBeInTheDocument();
  });
});
