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
  const [isSnapshotting, setIsSnapshotting] = useState(false);

  const { refetchInterval } = useRealtimePolling({
    enabled: poll && isSnapshotting,
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
    setIsSnapshotting(
      query.data?.some(({ snapshots }) =>
        Object.values(snapshots).some(
          (snapshot) => snapshot?.snapshotStatus === 'pending',
        ),
      ) ?? false,
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
