'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from './invalidateMcpIntegrationStatusQueries';

export function useRemoveExaApiKey() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.removeExaApiKey.mutationOptions({
      onSuccess: () => {
        void invalidateMcpIntegrationStatusQueries(queryClient, trpc);
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.exaConnection.queryKey(),
        });
      },
    }),
  );
}
