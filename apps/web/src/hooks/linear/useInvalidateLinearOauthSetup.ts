'use client';

import { useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useInvalidateLinearOauthSetup() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.linear.oauthSetup.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.mcpConnections.oauthReadiness.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.linear.installation.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
      }),
    ]);
  };
}
