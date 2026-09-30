'use client';

import { useQuery } from '@tanstack/react-query';

import { PendingIntegrationToolApprovals } from '@/components/sessions/PendingIntegrationToolApprovals';
import { useSessionIntegrationToolApprovals } from '@/hooks/useSessionIntegrationToolApprovals';
import { useTRPC } from '@/trpc/client';

/**
 * Approval cards for this
 * task's gated integration tool calls. A task's approvals are recorded on its
 * Session and answered by the Session owner, so this is the Session's own
 * card, narrowed to the asks this task raised. Anyone else sees nothing: the
 * route only returns the requester's pending approvals.
 */
export function PendingToolApprovalsPanel({ taskId }: { taskId: string }) {
  const trpc = useTRPC();
  const { data: parentSession } = useQuery(
    trpc.sessions.forTask.queryOptions({ taskId }),
  );
  const sessionId = parentSession?.sessionId;
  const approvals = useSessionIntegrationToolApprovals(sessionId);
  if (!sessionId) return null;

  return (
    <PendingIntegrationToolApprovals
      sessionId={sessionId}
      pending={(approvals.data?.pending ?? []).filter(
        (approval) => approval.taskId === taskId,
      )}
    />
  );
}
