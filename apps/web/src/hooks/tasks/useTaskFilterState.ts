import { useMemo } from 'react';

import type { Filter, FilterType } from '@/types';

export type TaskFilterState = {
  hasSpecificUserFilter: boolean;
  hasNonDefaultFilters: boolean;
};

type UseTaskFilterStateOptions = {
  defaultUserId?: string | null;
  ignoredFilterTypes?: FilterType[];
  includeImplicitDefaultUserFilter?: boolean;
};

export const useTaskFilterState = (
  filters: Filter[],
  {
    defaultUserId = null,
    ignoredFilterTypes = [],
    includeImplicitDefaultUserFilter = false,
  }: UseTaskFilterStateOptions = {},
): TaskFilterState =>
  useMemo(() => {
    const ignoredTypes = new Set<FilterType>(ignoredFilterTypes);
    const userFilter = filters.find((filter) => filter.type === 'userId');

    const hasSpecificUserFilter = userFilter
      ? userFilter.value !== 'all'
      : includeImplicitDefaultUserFilter && defaultUserId !== null;

    const hasNonDefaultFilters = filters.some((filter) => {
      if (ignoredTypes.has(filter.type)) {
        return false;
      }

      if (filter.type === 'userId') {
        if (filter.value === 'all') {
          return false;
        }

        if (defaultUserId !== null && filter.value === defaultUserId) {
          return false;
        }
      }

      return true;
    });

    return {
      hasSpecificUserFilter,
      hasNonDefaultFilters,
    };
  }, [
    filters,
    defaultUserId,
    ignoredFilterTypes,
    includeImplicitDefaultUserFilter,
  ]);
