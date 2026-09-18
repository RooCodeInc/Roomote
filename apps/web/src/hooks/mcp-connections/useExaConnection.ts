'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useExaConnection(enabled = true) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.mcpConnections.exaConnection.queryOptions(),
    enabled,
  });
}
