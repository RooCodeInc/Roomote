import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useAdoLinkedAccount = (options?: { enabled?: boolean }) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.linkedAccounts.ado.queryOptions(undefined, {
      enabled: options?.enabled ?? true,
    }),
  );
};
