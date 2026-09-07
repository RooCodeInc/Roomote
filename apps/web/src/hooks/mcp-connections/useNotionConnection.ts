'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useNotionConnection(enabled = true) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.mcpConnections.notionConnection.queryOptions(),
    enabled,
  });
}
