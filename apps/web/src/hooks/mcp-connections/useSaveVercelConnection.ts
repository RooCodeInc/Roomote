'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useSaveVercelConnection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.saveVercelConnection.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.userConnections.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.vercelConnection.queryKey(),
        });
      },
    }),
  );
}
