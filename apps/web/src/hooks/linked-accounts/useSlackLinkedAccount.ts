import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useSlackLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.slack.queryOptions());
};
