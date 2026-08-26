import { useQuery } from '@tanstack/react-query';

import type { TimePeriodFilter } from '@/types';
import { useTRPC } from '@/trpc/client';

export const useRepositoriesForFilter = (
  input: {
    userId: string | null;
    category: string | null;
    timePeriod: TimePeriodFilter;
  },
  options?: { enabled?: boolean },
) => {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.filters.repositories.queryOptions(input),
    enabled: options?.enabled ?? true,
  });
};
