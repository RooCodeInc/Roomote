'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useEffectiveMcpIntegrations() {
  const trpc = useTRPC();

  return useQuery(trpc.mcpConnections.effectiveIntegrations.queryOptions());
}
