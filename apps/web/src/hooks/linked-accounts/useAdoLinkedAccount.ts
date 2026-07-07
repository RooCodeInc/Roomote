import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useAdoLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.ado.queryOptions());
};
