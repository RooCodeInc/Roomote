import { z } from 'zod';

/**
 * Experiment-gated (`integrationToolApprovals`) per-integration-tool approval
 * policies and requests for code-mode integration calls in Sessions.
 *
 * Policies are deployment-scoped and admin-configured: one row per
 * (integration, tool) selects the approval mode, and the absence of a row is
 * the default `allow`, which preserves the pre-experiment behavior for that
 * tool. `ask` pauses the call behind a requester decision; `reject` blocks it
 * outright. Policies never widen access: the existing provider, actor, and
 * admin authorization ceilings decide which tools are mounted at all.
 */
export const INTEGRATION_TOOL_POLICY_MODES = [
  'allow',
  'ask',
  'reject',
] as const;
export type IntegrationToolPolicyMode =
  (typeof INTEGRATION_TOOL_POLICY_MODES)[number];
export const integrationToolPolicyModeSchema = z.enum(
  INTEGRATION_TOOL_POLICY_MODES,
);

export interface IntegrationToolPolicyMetadata {
  policyId: string;
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
  updatedAt: string;
  createdAt: string;
}

export const INTEGRATION_TOOL_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'consumed',
  'cancelled',
] as const;
export type IntegrationToolApprovalStatus =
  (typeof INTEGRATION_TOOL_APPROVAL_STATUSES)[number];

/**
 * The requester-facing view of one pending or decided approval.
 * `argsSummary` is redacted before storage; it never carries secret-looking
 * values or oversized strings.
 */
export interface IntegrationToolApprovalMetadata {
  approvalId: string;
  integrationId: string;
  toolName: string;
  argsSummary: unknown;
  status: IntegrationToolApprovalStatus;
  /** When this approval stops accepting a decision and fails closed. */
  expiresAt: string;
  createdAt: string;
}

export interface IntegrationToolApprovals {
  pending: IntegrationToolApprovalMetadata[];
}

export const integrationToolApprovalDecisionSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
});
export type IntegrationToolApprovalDecision = z.infer<
  typeof integrationToolApprovalDecisionSchema
>;

export const integrationToolPolicyUpsertSchema = z.object({
  integrationId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  mode: integrationToolPolicyModeSchema,
});
export type IntegrationToolPolicyUpsert = z.infer<
  typeof integrationToolPolicyUpsertSchema
>;
