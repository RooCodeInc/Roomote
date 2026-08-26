import { useQuery } from '@tanstack/react-query';

import type { TimePeriodFilter } from '@/types';
import { useTRPC } from '@/trpc/client';

export const useModelsForFilter = (
  input: {
    userId: string | null;
    category: string | null;
    repositoryName: string | null;
    timePeriod: TimePeriodFilter;
  },
  options?: { enabled?: boolean },
) => {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.filters.models.queryOptions(input),
    enabled: options?.enabled ?? true,
  });
};
