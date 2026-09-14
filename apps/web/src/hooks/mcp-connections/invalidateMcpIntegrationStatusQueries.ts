import type { QueryClient } from '@tanstack/react-query';

import type { useTRPC } from '@/trpc/client';

export function invalidateMcpIntegrationStatusQueries(
  queryClient: QueryClient,
  trpc: ReturnType<typeof useTRPC>,
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: trpc.mcpConnections.effectiveIntegrations.queryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.mcpConnections.userConnections.queryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.mcpConnections.oauthReadiness.queryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.mcpConnections.availability.queryKey(),
    }),
  ]);
}
