import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useEnvironmentsForFilter = (options?: { enabled?: boolean }) => {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.filters.environments.queryOptions(),
    enabled: options?.enabled ?? true,
  });
};
