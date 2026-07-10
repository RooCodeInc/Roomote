import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { isExitedRunStatus } from '@roomote/types';
import { useTRPC } from '@/trpc/client';

interface UseTaskOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

export const useTask = (
  taskId: string,
  includeArtifacts = true,
  options: UseTaskOptions = {},
) => {
  const { enabled = true, refetchInterval } = options;
  const trpc = useTRPC();
  const [isSnapshotting, setIsSnapshotting] = useState(false);

  const query = useQuery(
    trpc.tasks.byId.queryOptions(
      { taskId, includeArtifacts },
      {
        enabled: enabled && !!taskId,
        refetchInterval: isSnapshotting ? 2_000 : (refetchInterval ?? false),
      },
    ),
  );

  useEffect(
    () =>
      setIsSnapshotting(
        !!(
          query.data?.taskRun?.sleepRequestedAt ||
          query.data?.taskRun?.snapshotRequestedAt
        ) &&
          !isExitedRunStatus(query.data?.taskRun?.status) &&
          !query.data?.taskRun?.snapshotCreatedAt &&
          !query.data?.taskRun?.snapshotFailedAt,
      ),
    [query.data],
  );

  return query;
};
