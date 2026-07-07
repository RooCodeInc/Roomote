'use client';

import { skipToken, useQuery } from '@tanstack/react-query';

import type {
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';
import { useTRPC } from '@/trpc/client';

export function useAnalyticsDetails(
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
    bucketKey: string;
    seriesKey: string;
  } | null,
) {
  const trpc = useTRPC();

  return useQuery(trpc.analytics.details.queryOptions(input ?? skipToken));
}
