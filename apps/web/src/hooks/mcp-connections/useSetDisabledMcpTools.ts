'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useSetDisabledMcpTools() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.setDisabledTools.mutationOptions({
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.listTools.queryKey({
            mcpId: variables.mcpId,
          }),
        });
      },
    }),
  );
}
