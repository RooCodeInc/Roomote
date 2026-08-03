'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useCuratedIntegrationsAvailability() {
  const trpc = useTRPC();

  return useQuery(trpc.mcpConnections.availability.queryOptions());
}
