'use client';

import { useQuery } from '@tanstack/react-query';

import type { Filter, TimePeriodFilter } from '@/types';

import { useTRPC } from '@/trpc/client';

import { useCursorPagination } from '../usePagination';
import {
  type UseRealtimePollingOptions,
  useRealtimePolling,
} from '../useRealtimePolling';

interface UseTasksOptions {
  filters: Filter[];
  timePeriod: TimePeriodFilter;
  initialPageSize?: number;
  pollingOptions?: UseRealtimePollingOptions;
  enabled?: boolean;
}

export function useTasks({
  filters,
  timePeriod,
  initialPageSize = 20,
  pollingOptions = { enabled: true, interval: 5000 },
  enabled = true,
}: UseTasksOptions) {
  const trpc = useTRPC();
  const pagination = useCursorPagination(initialPageSize);
  const { pageSize: limit, currentCursor: cursor } = pagination;
  const polling = useRealtimePolling(pollingOptions);

  const result = useQuery(
    trpc.tasks.list.queryOptions(
      { limit, cursor, filters, timePeriod },
      { ...polling, enabled },
    ),
  );

  return { ...result, pagination };
}
