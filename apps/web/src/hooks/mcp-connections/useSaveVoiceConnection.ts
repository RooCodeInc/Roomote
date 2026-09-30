'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from './invalidateMcpIntegrationStatusQueries';

export function useSaveVoiceConnection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.mcpConnections.saveVoiceConnection.mutationOptions({
      onSuccess: () => {
        void invalidateMcpIntegrationStatusQueries(queryClient, trpc);
      },
    }),
  );
}
