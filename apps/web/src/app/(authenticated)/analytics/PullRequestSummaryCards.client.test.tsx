import { render, screen } from '@testing-library/react';

import { PullRequestSummaryCards } from './PullRequestSummaryCards';

describe('PullRequestSummaryCards', () => {
  it('renders summary metrics with granularity-normalized copy', () => {
    const { rerender } = render(
      <PullRequestSummaryCards
        isLoading={false}
        isError={false}
        granularity="day"
        summary={{
          totalPullRequests: 12,
          roomotePullRequests: {
            total: 3,
            percentage: 25,
          },
          mergedRoomotePullRequests: {
            total: 2,
            percentage: 66.666,
          },
          authorCount: 3,
          pullRequestsPerAuthor: 4,
          pullRequestsPerAuthorPerPeriod: 0.6,
        }}
      />,
    );

    expect(screen.getByText('Roomote PRs')).toBeInTheDocument();
    expect(screen.getByText('3 of 12')).toBeInTheDocument();
    expect(screen.getByText('25% of total PRs')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('66.7%')).toBeInTheDocument();
    expect(screen.getByText('PRs per each of 3 authors')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('0.6 PRs per author per day')).toBeInTheDocument();

    rerender(
      <PullRequestSummaryCards
        isLoading={false}
        isError={false}
        granularity="week"
        summary={{
          totalPullRequests: 0,
          roomotePullRequests: {
            total: 0,
            percentage: 0,
          },
          mergedRoomotePullRequests: {
            total: 0,
            percentage: 0,
          },
          authorCount: 0,
          pullRequestsPerAuthor: null,
          pullRequestsPerAuthorPerPeriod: null,
        }}
      />,
    );

    expect(screen.getByText('0 of 0')).toBeInTheDocument();
    expect(screen.getByText('0% of total PRs')).toBeInTheDocument();
    expect(screen.getAllByText('0%')).toHaveLength(1);
    expect(screen.getAllByText('0')).toHaveLength(1);
    expect(screen.getByText('PRs per each of 0 authors')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('— PRs per author per week')).toBeInTheDocument();
  });

  it('renders an explicit error state instead of summary metrics', () => {
    render(
      <PullRequestSummaryCards
        isLoading={false}
        isError={true}
        granularity="day"
        summary={undefined}
      />,
    );

    expect(screen.getByText('Unable to load PR summary')).toBeInTheDocument();
    expect(
      screen.getByText('Please refresh the page and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Roomote PRs')).not.toBeInTheDocument();
  });
});
