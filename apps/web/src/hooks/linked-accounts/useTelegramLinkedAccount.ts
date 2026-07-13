import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useTelegramLinkedAccount = (options?: {
  refetchInterval?: number | false;
}) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.linkedAccounts.telegram.queryOptions(undefined, {
      refetchInterval: options?.refetchInterval,
    }),
  );
};
