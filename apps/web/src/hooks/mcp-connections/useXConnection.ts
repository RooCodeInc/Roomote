'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useXConnection(enabled = true) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.mcpConnections.xConnection.queryOptions(),
    enabled,
  });
}
