'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useStripeConnection(enabled = true) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.mcpConnections.stripeConnection.queryOptions(),
    enabled,
  });
}
