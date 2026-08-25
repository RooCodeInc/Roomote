'use client';

import { useInfiniteQuery } from '@tanstack/react-query';

import type { Filter, TaskBoardColumn, TimePeriodFilter } from '@/types';

import { useTRPC } from '@/trpc/client';

import {
  type UseRealtimePollingOptions,
  useRealtimePolling,
} from '../useRealtimePolling';

interface UseInfiniteTasksOptions {
  filters: Filter[];
  timePeriod: TimePeriodFilter;
  boardColumn?: TaskBoardColumn;
  pageSize?: number;
  pollingOptions?: UseRealtimePollingOptions;
  enabled?: boolean;
}

export function useInfiniteTasks({
  filters,
  timePeriod,
  boardColumn,
  pageSize = 50,
  pollingOptions = { enabled: true, interval: 5000 },
  enabled = true,
}: UseInfiniteTasksOptions) {
  const trpc = useTRPC();
  const polling = useRealtimePolling(pollingOptions);

  return useInfiniteQuery(
    trpc.tasks.list.infiniteQueryOptions(
      {
        limit: pageSize,
        filters,
        timePeriod,
        ...(boardColumn ? { boardColumn } : {}),
      },
      {
        ...polling,
        enabled,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
    ),
  );
}
