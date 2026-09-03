import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useArtifactByPath(
  owner: { taskId: string } | { sessionId: string } | null | undefined,
  path: string | null | undefined,
  version?: number,
) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.artifacts.byPath.queryOptions(
      { ...owner!, path: path || '', version },
      { enabled: !!owner && !!path },
    ),
  });
}
