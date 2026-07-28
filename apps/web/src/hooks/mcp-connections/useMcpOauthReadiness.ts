'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useMcpOauthReadiness() {
  const trpc = useTRPC();

  return useQuery(trpc.mcpConnections.oauthReadiness.queryOptions());
}
