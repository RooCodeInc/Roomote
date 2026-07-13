import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useDiscordLinkedAccount = (options?: {
  refetchInterval?: number | false;
}) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.linkedAccounts.discord.queryOptions(undefined, {
      refetchInterval: options?.refetchInterval,
    }),
  );
};
