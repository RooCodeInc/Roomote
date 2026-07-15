import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useTeamsIntegrationStatus = (options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.teams.integrationStatus.queryOptions(undefined, {
      enabled: options?.enabled,
      refetchInterval: options?.refetchInterval,
    }),
  );
};
