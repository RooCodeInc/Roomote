'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from './invalidateMcpIntegrationStatusQueries';

export function useSaveStripeConnection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.saveStripeConnection.mutationOptions({
      onSuccess: () => {
        void invalidateMcpIntegrationStatusQueries(queryClient, trpc);
        queryClient.invalidateQueries({
          queryKey: trpc.mcpConnections.stripeConnection.queryKey(),
        });
      },
    }),
  );
}
