import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useArtifactByPath(
  taskId: string | null | undefined,
  path: string | null | undefined,
  version?: number,
) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.artifacts.byPath.queryOptions(
      { taskId: taskId!, path: path || '', version },
      { enabled: !!taskId && !!path },
    ),
  });
}
