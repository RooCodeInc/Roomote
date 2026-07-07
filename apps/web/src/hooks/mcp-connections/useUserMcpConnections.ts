'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useUserMcpConnections() {
  const trpc = useTRPC();

  return useQuery(trpc.mcpConnections.userConnections.queryOptions());
}
