'use client';

import { useQuery } from '@tanstack/react-query';
import type { ServiceCredentialApprovals } from '@roomote/types';

/**
 * The owner's view of a Session's integration keys: approvals still waiting
 * for a key, plus the integrations already usable. Read from the same
 * owner-only route the key dialog submits to; the card, the dialog, and the
 * transcript trigger all share this one query.
 */
export function sessionIntegrationApprovalsQueryKey(sessionId: string) {
  return ['session-integration-approvals', sessionId] as const;
}

export async function fetchSessionIntegrationApprovals(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ServiceCredentialApprovals> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/secrets`,
    { cache: 'no-store', credentials: 'same-origin', signal },
  );
  if (!response.ok) throw new Error('Unavailable');
  return (await response.json()) as ServiceCredentialApprovals;
}

export function useSessionIntegrationApprovals(sessionId: string | undefined) {
  return useQuery({
    queryKey: sessionIntegrationApprovalsQueryKey(sessionId ?? ''),
    enabled: Boolean(sessionId),
    queryFn: ({ signal }) =>
      fetchSessionIntegrationApprovals(sessionId ?? '', signal),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
