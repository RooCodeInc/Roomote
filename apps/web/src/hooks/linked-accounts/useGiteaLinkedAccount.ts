import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useGiteaLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.gitea.queryOptions());
};
