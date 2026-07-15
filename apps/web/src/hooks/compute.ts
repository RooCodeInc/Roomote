'use client';

import { useQuery } from '@tanstack/react-query';
import type { ComputeProvider } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

/**
 * Whether a compute provider is currently configured for task launch,
 * per the deployment's compute status. Resolves to false while the status
 * is still loading.
 */
export function useComputeProviderConfigured(
  provider: ComputeProvider,
): boolean {
  const trpc = useTRPC();
  const status = useQuery(trpc.compute.status.queryOptions());

  return (
    status.data?.providers.some(
      (candidate) =>
        candidate.provider === provider && candidate.configSatisfied,
    ) ?? false
  );
}
