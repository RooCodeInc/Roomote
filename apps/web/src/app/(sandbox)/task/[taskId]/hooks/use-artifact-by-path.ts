import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

const VERSIONED_ARTIFACT_STALE_TIME_MS = 50 * 60 * 1000;

export function useArtifactByPath(
  owner: { taskId: string } | { sessionId: string } | null | undefined,
  path: string | null | undefined,
  version?: number,
) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.artifacts.byPath.queryOptions(
      { ...owner!, path: path || '', version },
      {
        enabled: !!owner && !!path,
        // Versioned artifact URLs are valid for one hour. Keep cached detail
        // responses fresh long enough to reuse the browser's media cache.
        staleTime:
          version === undefined ? undefined : VERSIONED_ARTIFACT_STALE_TIME_MS,
      },
    ),
  });
}
