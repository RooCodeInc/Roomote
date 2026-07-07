import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useLinearLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.linear.queryOptions());
};
