'use client';

import { useQuery } from '@tanstack/react-query';
import type { ToolCallApprovals } from '@roomote/types';

/**
 * The requester's view of experiment-gated (`toolApprovals`) tool-call
 * approvals waiting on an answer. Read from the same requester-only route
 * the decision buttons submit to.
 */
function sessionToolApprovalsQueryKey(sessionId: string) {
  return ['session-tool-approvals', sessionId] as const;
}

async function fetchSessionToolApprovals(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ToolCallApprovals> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/tool-approvals`,
    { cache: 'no-store', credentials: 'same-origin', signal },
  );
  if (!response.ok) throw new Error('Unavailable');
  return (await response.json()) as ToolCallApprovals;
}

export function useSessionToolApprovals(
  sessionId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: sessionToolApprovalsQueryKey(sessionId ?? ''),
    enabled: Boolean(sessionId) && enabled,
    queryFn: ({ signal }) => fetchSessionToolApprovals(sessionId ?? '', signal),
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
}
