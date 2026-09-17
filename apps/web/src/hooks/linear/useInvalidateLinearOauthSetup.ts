'use client';

import { useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from '@/hooks/mcp-connections';

export function useInvalidateLinearOauthSetup() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return async () => {
    await Promise.all([
      invalidateMcpIntegrationStatusQueries(queryClient, trpc),
      queryClient.invalidateQueries({
        queryKey: trpc.linear.oauthSetup.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.linear.installation.queryKey(),
      }),
    ]);
  };
}
