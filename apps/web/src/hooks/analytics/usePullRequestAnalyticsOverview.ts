'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type {
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  TimePeriodFilter,
} from '@/types';
import { useTRPC } from '@/trpc/client';

export function usePullRequestAnalyticsOverview(
  input: {
    viewBy: AnalyticsDimension;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
  options?: {
    enabled?: boolean;
  },
) {
  const trpc = useTRPC();

  return useQuery(
    trpc.analytics.pullRequestOverview.queryOptions(input, {
      placeholderData: keepPreviousData,
      enabled: options?.enabled,
    }),
  );
}
