import { render, screen } from '@testing-library/react';

import { AnalyticsControlRow } from './AnalyticsControlRow';

describe('AnalyticsControlRow', () => {
  it('renders the view-by select and unlabeled desktop time range control', () => {
    render(
      <AnalyticsControlRow
        object="pullRequests"
        viewBy="user"
        timePeriod={30}
        onViewByChange={vi.fn()}
        onTimePeriodChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'View by' })).toHaveTextContent(
      'User',
    );
    expect(screen.getByText('Last 30 Days')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Time range' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Time range')).not.toBeInTheDocument();
    expect(screen.queryByText('Granularity')).not.toBeInTheDocument();
  });
});
