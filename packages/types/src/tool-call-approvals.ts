import { z } from 'zod';

/**
 * The requester-facing view of one experiment-gated (`toolApprovals`)
 * on-demand integration tool-call approval. `argsSummary` is redacted before
 * storage; it never carries secret-looking values or oversized strings.
 */
export interface ToolCallApprovalMetadata {
  approvalId: string;
  integrationId: string;
  toolName: string;
  argsSummary: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  /** When this approval stops accepting a decision and fails closed. */
  expiresAt: string;
  createdAt: string;
}

export interface ToolCallApprovals {
  pending: ToolCallApprovalMetadata[];
}

export const toolCallApprovalDecisionSchema = z
  .object({
    approvalId: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

export type ToolCallApprovalDecision = z.infer<
  typeof toolCallApprovalDecisionSchema
>;
