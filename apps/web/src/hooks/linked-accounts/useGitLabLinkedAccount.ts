import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useGitLabLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.gitlab.queryOptions());
};
