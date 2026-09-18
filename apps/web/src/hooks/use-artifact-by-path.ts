import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

const VERSIONED_ARTIFACT_STALE_TIME_MS = 50 * 60 * 1000;

export function useArtifactByPath(
  owner: { taskId: string } | { sessionId: string } | null | undefined,
  path: string | null | undefined,
  version?: number,
  contentMode: 'full' | 'preview' = 'full',
) {
  const trpc = useTRPC();
  const input = {
    ...owner!,
    path: path || '',
    version,
    ...(contentMode === 'preview' ? { preview: true } : {}),
  };

  return useQuery({
    ...trpc.artifacts.byPath.queryOptions(input, {
      enabled: !!owner && !!path,
      // Versioned artifact URLs are valid for one hour. Keep cached detail
      // responses fresh long enough to reuse content and the media cache.
      staleTime:
        version === undefined ? undefined : VERSIONED_ARTIFACT_STALE_TIME_MS,
    }),
  });
}
