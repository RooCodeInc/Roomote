import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { isExitedCloudTaskStatus } from '@roomote/types';
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
          query.data?.cloudJob?.sleepRequestedAt ||
          query.data?.cloudJob?.snapshotRequestedAt
        ) &&
          !isExitedCloudTaskStatus(query.data?.cloudJob?.status) &&
          !query.data?.cloudJob?.snapshotCreatedAt &&
          !query.data?.cloudJob?.snapshotFailedAt,
      ),
    [query.data],
  );

  return query;
};
