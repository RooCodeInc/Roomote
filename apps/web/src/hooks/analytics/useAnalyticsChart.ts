'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type {
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  AnalyticsMetric,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';
import { useTRPC } from '@/trpc/client';

export function useAnalyticsChart(
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
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
    trpc.analytics.chart.queryOptions(input, {
      placeholderData: keepPreviousData,
      enabled: options?.enabled,
    }),
  );
}
