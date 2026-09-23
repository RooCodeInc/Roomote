import {
  decideIntegrationToolApproval,
  getIntegrationToolApproval,
} from '@roomote/db/server';
import type { IntegrationToolApprovalDecision } from '@roomote/types';

/** Provider callbacks carry only a row ID and a choice. They never grant
 * authority: the linked sender must be the Session requester and the row
 * must still be pending. All failures
 * have the same answer to avoid disclosing another person's pending call. */
export async function decideCommunicationToolApproval(
  userId: string | null,
  decision: IntegrationToolApprovalDecision,
): Promise<boolean> {
  if (!userId) return false;
  const row = await getIntegrationToolApproval(decision.approvalId);
  if (!row || row.requesterUserId !== userId) return false;
  try {
    await decideIntegrationToolApproval(
      { sessionId: row.sessionId, userId },
      decision,
    );
    return true;
  } catch {
    return false;
  }
}
