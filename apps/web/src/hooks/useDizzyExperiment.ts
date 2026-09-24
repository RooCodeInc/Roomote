'use client';

import { useQuery } from '@tanstack/react-query';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

export function useDizzyExperiment(): boolean {
  const { nightlyExperimentsEnabled } = useAuthorizedUser();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.nightlyExperiments.dizzyEnabled.queryOptions(undefined, {
      enabled: nightlyExperimentsEnabled === true,
    }),
  );

  return nightlyExperimentsEnabled === true && query.data === true;
}
