'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from './invalidateMcpIntegrationStatusQueries';

export function useSaveNotionConnection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.saveNotionConnection.mutationOptions({
      onSuccess: () => {
        void invalidateMcpIntegrationStatusQueries(queryClient, trpc);
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.notionConnection.queryKey(),
        });
      },
    }),
  );
}
