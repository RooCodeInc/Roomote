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
    // Voice's card reads its on/off state from this query when the key comes
    // from the environment, so a deployment toggle must refresh it too.
    queryClient.invalidateQueries({
      queryKey: trpc.mcpConnections.voiceConnection.queryKey(),
    }),
  ]);
}
