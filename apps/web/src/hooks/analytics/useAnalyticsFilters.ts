'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type {
  AnalyticsFilters,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';
import { useTRPC } from '@/trpc/client';

export function useAnalyticsFilters(
  input: {
    object: AnalyticsObject;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
  },
  options?: {
    enabled?: boolean;
  },
) {
  const trpc = useTRPC();

  return useQuery(
    trpc.analytics.filters.queryOptions(input, {
      placeholderData: keepPreviousData,
      enabled: options?.enabled,
    }),
  );
}
