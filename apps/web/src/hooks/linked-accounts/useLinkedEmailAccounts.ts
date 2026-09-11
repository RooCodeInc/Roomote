import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useLinkedEmailAccounts = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.email.queryOptions());
};
