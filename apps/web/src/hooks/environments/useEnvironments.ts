'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { useRealtimePolling } from '@/hooks/useRealtimePolling';

export function useEnvironments({
  poll = false,
  enabled = true,
}: {
  poll?: boolean;
  enabled?: boolean;
} = {}) {
  const trpc = useTRPC();
  const [hasActiveWork, setHasActiveWork] = useState(false);

  const { refetchInterval } = useRealtimePolling({
    enabled: poll && hasActiveWork,
    interval: 3000,
  });

  const query = useQuery(
    trpc.environments.list.queryOptions(undefined, {
      enabled,
      refetchInterval: poll ? refetchInterval : false,
    }),
  );

  useEffect(() => {
    if (!poll || !enabled) return;
    // Keep polling while a snapshot is being created or an environment's
    // verification is still in progress, so status badges update on their own.
    setHasActiveWork(
      query.data?.some((environment) => {
        const isSnapshotting = Object.values(environment.snapshots).some(
          (snapshot) => snapshot?.snapshotStatus === 'pending',
        );
        const verificationInProgress =
          !environment.isVerified &&
          !environment.verificationError &&
          !!environment.verificationTaskId &&
          environment.verificationTaskActive;

        return isSnapshotting || verificationInProgress;
      }) ?? false,
    );
  }, [enabled, poll, query.data]);

  return query;
}

export function useEnvironment(id: string | undefined) {
  const trpc = useTRPC();

  return useQuery(
    trpc.environments.byId.queryOptions(
      { id: id! },
      {
        enabled: !!id,
      },
    ),
  );
}
