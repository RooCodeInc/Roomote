'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from './invalidateMcpIntegrationStatusQueries';

export function useDisconnectMcp() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.disconnect.mutationOptions({
      onSuccess: () => {
        void invalidateMcpIntegrationStatusQueries(queryClient, trpc);
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.snowflakeConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.asanaConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.granolaConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.ripplingConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.grafanaConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.vercelConnection.queryKey(),
        });
      },
    }),
  );
}
