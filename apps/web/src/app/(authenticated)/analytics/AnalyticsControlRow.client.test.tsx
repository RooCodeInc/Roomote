import { render, screen } from '@testing-library/react';

import { AnalyticsControlRow } from './AnalyticsControlRow';

describe('AnalyticsControlRow', () => {
  it('renders the view-by select and unlabeled desktop time range control', () => {
    render(
      <AnalyticsControlRow
        object="pullRequests"
        viewBy="user"
        metric="tasks"
        timePeriod={30}
        granularity="month"
        availableGranularities={['day', 'week', 'month', 'year']}
        onViewByChange={vi.fn()}
        onMetricChange={vi.fn()}
        onTimePeriodChange={vi.fn()}
        onGranularityChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'View by' })).toHaveTextContent(
      'User',
    );
    expect(screen.getByText('Last 30 Days')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Time range' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Chart granularity' }),
    ).toHaveTextContent('By Month');
    expect(screen.queryByText('Time range')).not.toBeInTheDocument();
    expect(screen.queryByText('Granularity')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Metric' }),
    ).not.toBeInTheDocument();
  });

  it('does not render a metric selector for tasks analytics', () => {
    render(
      <AnalyticsControlRow
        object="tasks"
        viewBy="user"
        metric="tasks"
        timePeriod={7}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        onViewByChange={vi.fn()}
        onMetricChange={vi.fn()}
        onTimePeriodChange={vi.fn()}
        onGranularityChange={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole('combobox', { name: 'Metric' }),
    ).not.toBeInTheDocument();
  });
});
