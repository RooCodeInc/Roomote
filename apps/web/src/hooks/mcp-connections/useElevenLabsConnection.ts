'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useElevenLabsConnection(enabled = true) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.mcpConnections.elevenLabsConnection.queryOptions(),
    enabled,
  });
}
