'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IntegrationToolApprovals,
  IntegrationToolSessionOverrideUpsert,
} from '@roomote/types';

/**
 * The requester's view of experiment-gated (`integrationToolApprovals`)
 * integration tool approvals waiting on an answer. Read from the same
 * requester-only route the decision buttons submit to.
 */
function sessionIntegrationToolApprovalsQueryKey(sessionId: string) {
  return ['session-integration-tool-approvals', sessionId] as const;
}

async function fetchSessionIntegrationToolApprovals(
  sessionId: string,
  signal?: AbortSignal,
): Promise<IntegrationToolApprovals> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/integration-tool-approvals`,
    { cache: 'no-store', credentials: 'same-origin', signal },
  );
  if (!response.ok) throw new Error('Unavailable');
  return (await response.json()) as IntegrationToolApprovals;
}

export function useSessionIntegrationToolApprovals(
  sessionId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: sessionIntegrationToolApprovalsQueryKey(sessionId ?? ''),
    enabled: Boolean(sessionId) && enabled,
    queryFn: ({ signal }) =>
      fetchSessionIntegrationToolApprovals(sessionId ?? '', signal),
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Requester-only write of one session-scoped override: `ask` gates a tool
 * for this Session, `allow` stops its asks, `null` restores the deployment
 * policy. Tightening applies from the next session turn.
 */
export function useSetSessionIntegrationToolOverride(
  sessionId: string | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: IntegrationToolSessionOverrideUpsert) => {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId ?? '')}/integration-tool-approvals`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error('Unavailable');
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: sessionIntegrationToolApprovalsQueryKey(sessionId ?? ''),
      }),
  });
}
