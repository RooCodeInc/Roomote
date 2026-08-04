'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useSaveGranolaConnection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.saveGranolaConnection.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.userConnections.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.granolaConnection.queryKey(),
        });
      },
    }),
  );
}
