'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useDisconnectMcp() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.disconnect.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.userConnections.queryKey(),
        });
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
          queryKey: trpc.mcpConnections.grafanaConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.vercelConnection.queryKey(),
        });
      },
    }),
  );
}
