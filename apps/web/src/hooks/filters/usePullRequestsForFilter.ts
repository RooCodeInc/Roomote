import { useQuery } from '@tanstack/react-query';

import type { TimePeriodFilter } from '@/types';
import { useTRPC } from '@/trpc/client';

export const usePullRequestsForFilter = (
  input: {
    userId: string | null;
    category: string | null;
    repositoryName: string | null;
    timePeriod: TimePeriodFilter;
    search: string;
  },
  options?: { enabled?: boolean },
) => {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.filters.pullRequests.queryOptions(input),
    enabled: options?.enabled ?? true,
  });
};
