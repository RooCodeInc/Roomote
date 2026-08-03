'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useDisableAllIntegrations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.disableAll.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.userConnections.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.linear.installation.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.linear.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.snowflakeConnection.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.asanaConnection.queryKey(),
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
