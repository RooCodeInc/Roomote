import { render, screen } from '@testing-library/react';

import { CostSummaryCards } from './CostSummaryCards';

describe('CostSummaryCards', () => {
  it('renders cost summary metrics using analytics summary card copy', () => {
    render(
      <CostSummaryCards
        timePeriod={7}
        summary={{
          totalInferenceCost: 12.345,
          averageCostPerPr: 4.5,
          averageCostPerTask: 1.25,
          averageCostPerActiveUser: null,
          prCount: 2,
          taskCount: 3,
          activeUserCount: 0,
        }}
      />,
    );

    expect(screen.getByText('Total inference cost')).toBeInTheDocument();
    expect(screen.getByText('$12.35')).toBeInTheDocument();
    expect(screen.getByText('Last 7 Days')).toBeInTheDocument();
    expect(screen.getByText('Average cost per PR')).toBeInTheDocument();
    expect(screen.getByText('$4.50')).toBeInTheDocument();
    expect(screen.getByText('Across 2 PRs')).toBeInTheDocument();
    expect(screen.getByText('Average cost per task')).toBeInTheDocument();
    expect(screen.getByText('$1.25')).toBeInTheDocument();
    expect(screen.getByText('Across 3 tasks')).toBeInTheDocument();
    expect(
      screen.getByText('Average cost per active user'),
    ).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Amongst 0 active users')).toBeInTheDocument();
  });

  it('renders nothing before summary data is available', () => {
    const { container } = render(
      <CostSummaryCards summary={undefined} timePeriod={7} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('uses singular contextual footers when counts are one', () => {
    render(
      <CostSummaryCards
        timePeriod="all"
        summary={{
          totalInferenceCost: 2,
          averageCostPerPr: 2,
          averageCostPerTask: 2,
          averageCostPerActiveUser: 2,
          prCount: 1,
          taskCount: 1,
          activeUserCount: 1,
        }}
      />,
    );

    expect(screen.getByText('All Time')).toBeInTheDocument();
    expect(screen.getByText('Across 1 PR')).toBeInTheDocument();
    expect(screen.getByText('Across 1 task')).toBeInTheDocument();
    expect(screen.getByText('Amongst 1 active user')).toBeInTheDocument();
  });
});
