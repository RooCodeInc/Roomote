'use client';

import { PRODUCT_NAME } from '@roomote/types';

import type {
  AnalyticsGranularity,
  PullRequestAnalyticsSummary,
} from '@/types';
import { Card, CardContent, ErrorState, Skeleton } from '@/components/system';

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

function SummaryCard({
  label,
  value,
  secondary,
}: {
  label: string;
  value: string;
  secondary: string;
}) {
  return (
    <div className="bg-card gap-1 p-4">
      <p className="text-sm font-medium leading-snug text-muted-foreground">
        {label}
      </p>
      <div className="space-y-1 pt-0">
        <div className="text-2xl font-semibold leading-tight tracking-tight text-foreground md:text-3xl">
          {value}
        </div>
        <div className="text-sm text-muted-foreground">{secondary}</div>
      </div>
    </div>
  );
}

function SummaryCardSkeleton() {
  return (
    <div className="bg-card p-4 space-y-2">
      <Skeleton className="h-4 w-28" />
      <div className="space-y-2 pt-0">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-20" />
      </div>
    </div>
  );
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
      <div className="grid gap-0.5 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <SummaryCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid gap-0.5 md:grid-cols-2 xl:grid-cols-3">
        <Card className="bg-card md:col-span-2 xl:col-span-3">
          <CardContent>
            <ErrorState
              title="Unable to load PR summary"
              description="Please refresh the page and try again."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!summary) {
    return null;
  }

  return (
    <div className="grid gap-0.5 md:grid-cols-2 xl:grid-cols-3">
      <SummaryCard
        label={`${PRODUCT_NAME} PRs`}
        value={`${formatCount(summary.roomotePullRequests.total)} of ${formatCount(summary.totalPullRequests)}`}
        secondary={`${formatPercentage(summary.roomotePullRequests.percentage)} of total PRs`}
      />
      <SummaryCard
        label={`Merged ${PRODUCT_NAME} PRs`}
        value={formatCount(summary.mergedRoomotePullRequests.total)}
        secondary={formatPercentage(
          summary.mergedRoomotePullRequests.percentage,
        )}
      />
      <SummaryCard
        label={`PRs per each of ${formatCount(summary.authorCount)} ${summary.authorCount === 1 ? 'author' : 'authors'}`}
        value={formatAverage(summary.pullRequestsPerAuthor)}
        secondary={formatPerAuthorPerPeriod(
          summary.pullRequestsPerAuthorPerPeriod,
          granularity,
        )}
      />
    </div>
  );
}
