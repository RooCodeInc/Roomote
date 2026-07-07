import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useGitHubLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.github.queryOptions());
};
