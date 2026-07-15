'use client';

import { PRODUCT_NAME } from '@roomote/types';

import type {
  AnalyticsGranularity,
  PullRequestAnalyticsSummary,
} from '@/types';
import { Card, CardContent, ErrorState } from '@/components/system';

import {
  AnalyticsSummaryCard,
  AnalyticsSummaryCardsGrid,
  AnalyticsSummaryCardSkeleton,
} from './AnalyticsSummaryCards';

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercentage(value: number) {
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

function formatAverage(value: number | null) {
  if (value === null) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPerAuthorPerPeriod(
  value: number | null,
  granularity: AnalyticsGranularity,
) {
  return `${formatAverage(value)} PRs per author per ${granularity}`;
}

export function PullRequestSummaryCards({
  summary,
  isLoading,
  isError,
  granularity,
}: {
  summary: PullRequestAnalyticsSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  granularity: AnalyticsGranularity;
}) {
  if (isLoading) {
    return (
      <AnalyticsSummaryCardsGrid>
        {Array.from({ length: 3 }).map((_, index) => (
          <AnalyticsSummaryCardSkeleton key={index} />
        ))}
      </AnalyticsSummaryCardsGrid>
    );
  }

  if (isError) {
    return (
      <AnalyticsSummaryCardsGrid>
        <Card className="bg-card md:col-span-2 xl:col-span-3">
          <CardContent>
            <ErrorState
              title="Unable to load PR summary"
              description="Please refresh the page and try again."
            />
          </CardContent>
        </Card>
      </AnalyticsSummaryCardsGrid>
    );
  }

  if (!summary) {
    return null;
  }

  return (
    <AnalyticsSummaryCardsGrid>
      <AnalyticsSummaryCard
        label={`${PRODUCT_NAME} PRs`}
        value={`${formatCount(summary.roomotePullRequests.total)} of ${formatCount(summary.totalPullRequests)}`}
        secondary={`${formatPercentage(summary.roomotePullRequests.percentage)} of total PRs`}
      />
      <AnalyticsSummaryCard
        label={`Merged ${PRODUCT_NAME} PRs`}
        value={formatCount(summary.mergedRoomotePullRequests.total)}
        secondary={formatPercentage(
          summary.mergedRoomotePullRequests.percentage,
        )}
      />
      <AnalyticsSummaryCard
        label={`PRs per each of ${formatCount(summary.authorCount)} ${summary.authorCount === 1 ? 'author' : 'authors'}`}
        value={formatAverage(summary.pullRequestsPerAuthor)}
        secondary={formatPerAuthorPerPeriod(
          summary.pullRequestsPerAuthorPerPeriod,
          granularity,
        )}
      />
    </AnalyticsSummaryCardsGrid>
  );
}
