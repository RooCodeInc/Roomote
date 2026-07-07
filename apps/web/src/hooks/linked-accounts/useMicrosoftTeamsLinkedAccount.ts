import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useMicrosoftTeamsLinkedAccount = () => {
  const trpc = useTRPC();

  return useQuery(trpc.linkedAccounts.microsoftTeams.queryOptions());
};
