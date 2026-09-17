'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function usePrivateSessionsExperiment() {
  const trpc = useTRPC();
  const experiment = useQuery(
    trpc.miscSettings.privateSessionsExperiment.queryOptions(),
  );

  return {
    enabled: experiment.data === true,
    isLoading: experiment.isPending,
  };
}
