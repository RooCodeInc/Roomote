import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useBitbucketLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.bitbucket.queryOptions());
};
