'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useRipplingConnection(enabled = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.mcpConnections.ripplingConnection.queryOptions(),
    enabled,
  });
}
