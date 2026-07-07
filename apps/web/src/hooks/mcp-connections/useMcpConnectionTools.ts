'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useMcpConnectionTools(mcpId: string | null) {
  const trpc = useTRPC();

  return useQuery(
    trpc.mcpConnections.listTools.queryOptions(
      { mcpId: mcpId ?? '' },
      { enabled: mcpId != null, retry: false },
    ),
  );
}
