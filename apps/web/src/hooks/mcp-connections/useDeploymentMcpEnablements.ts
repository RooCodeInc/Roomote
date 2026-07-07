'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useDeploymentMcpEnablements() {
  const trpc = useTRPC();

  return useQuery(trpc.mcpConnections.deploymentEnablements.queryOptions());
}
