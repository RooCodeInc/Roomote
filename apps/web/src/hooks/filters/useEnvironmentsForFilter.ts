import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useEnvironmentsForFilter = () => {
  const trpc = useTRPC();

  return useQuery(trpc.filters.environments.queryOptions());
};
