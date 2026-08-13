'use client';

import { useQuery } from '@tanstack/react-query';
import type { ComputeProvider } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

export function useConfiguredComputeProviders(): ComputeProvider[] {
  const trpc = useTRPC();
  const status = useQuery(trpc.compute.status.queryOptions());

  return (
    status.data?.providers
      .filter((provider) => provider.configSatisfied)
      .map((provider) => provider.provider) ?? []
  );
}
