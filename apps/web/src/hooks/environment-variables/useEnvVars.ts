'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useEnvVars({ enabled = true }: { enabled?: boolean } = {}) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.environmentVariables.list.queryOptions(undefined),
    enabled,
  });
}
