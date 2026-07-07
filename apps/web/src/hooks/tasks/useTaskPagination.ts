'use client';

import { useEffect, useRef } from 'react';

import type { Filter, TimePeriodFilter } from '@/types';

import type { CursorPaginationControls } from '../usePagination';

/**
 * Resets cursor pagination when filters or time period change, and syncs the
 * next cursor returned by the server into the pagination state.
 */
export function useTaskPagination(
  pagination: CursorPaginationControls,
  filters: Filter[],
  timePeriod: TimePeriodFilter,
  nextCursor: string | undefined,
) {
  const prevFilters = useRef<Filter[]>([]);
  const prevTimePeriod = useRef<TimePeriodFilter>(timePeriod);

  useEffect(() => {
    const hasFiltersChanged =
      prevFilters.current.length !== filters.length ||
      prevFilters.current.some(
        (prevFilter, index) =>
          prevFilter.type !== filters[index]?.type ||
          prevFilter.value !== filters[index]?.value,
      );

    const hasTimePeriodChanged = prevTimePeriod.current !== timePeriod;

    if (hasFiltersChanged || hasTimePeriodChanged) {
      pagination.reset();
      prevFilters.current = [...filters];
      prevTimePeriod.current = timePeriod;
    }
  }, [filters, timePeriod, pagination]);

  useEffect(() => {
    if (nextCursor !== undefined) {
      pagination.setNextCursor(nextCursor);
    }
  }, [nextCursor, pagination]);
}
