import { z } from 'zod';

/**
 * Experiment-gated (`integrationToolApprovals`) per-integration-tool approval
 * policies and requests for code-mode integration calls in Sessions.
 *
 * Policies are deployment-scoped and admin-configured: one row per
 * (integration, tool) selects the approval mode, and the absence of a row is
 * the default `allow`, which preserves the pre-experiment behavior for that
 * tool. `ask` pauses the call behind a requester decision; `reject` blocks it
 * outright. `auto` is a SHADOW/PREVIEW mode: the call still pauses behind the
 * same requester decision as `ask`, but the configured judgment model records
 * what it would have recommended (would_approve / would_ask) so deployments
 * can measure agreement before trusting any automation. The evaluator can
 * never allow a call, change grants, or override `reject`/`ask`.
 * Policies never widen access: the existing provider, actor, and
 * admin authorization ceilings decide which tools are mounted at all.
 */
export const INTEGRATION_TOOL_POLICY_MODES = [
  'allow',
  'ask',
  'reject',
  'auto',
] as const;
export type IntegrationToolPolicyMode =
  (typeof INTEGRATION_TOOL_POLICY_MODES)[number];
export const integrationToolPolicyModeSchema = z.enum(
  INTEGRATION_TOOL_POLICY_MODES,
);

/**
 * Default approval instruction used for the `auto` shadow evaluation when a
 * policy does not define its own. The instruction is deployment policy given
 * to the judgment model; tool descriptions and arguments are always presented
 * to the evaluator as untrusted data, never as instructions.
 */
export const DEFAULT_INTEGRATION_TOOL_AUTO_APPROVAL_INSTRUCTION =
  'Only actions clearly requested by the user that are not destructive or irreversible';

export interface IntegrationToolPolicyMetadata {
  policyId: string;
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
  /**
   * Optional per-policy approval instruction for the `auto` shadow
   * evaluation. Absent means the deployment default instruction.
   */
  instruction?: string;
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
/**
 * What the judgment model recommended for one `auto` (shadow/preview) gated
 * call. This is advisory only: it is recorded for evaluation and shown to the
 * requester as a preview, but the human decision in the same approval row
 * remains the only authorization. `would_ask` is also the recorded outcome on
 * every evaluator failure (timeout, invalid output, unconfigured backend), so
 * the audit can never read as an implicit approval.
 */
export interface IntegrationToolApprovalShadowEvaluation {
  recommendation: 'would_approve' | 'would_ask';
  /** Why the evaluator landed here, including failure reasons. */
  reason: string;
  /** Distribution concentration reported by the model, when available. */
  confidence?: number;
  /** Provider that answered, when a backend was configured. */
  provider?: 'typesafe' | 'openrouter' | 'vercel';
  /**
   * The exact model identifier sent to the provider. Some providers use a
   * floating alias (for example `jev-latest`); this records what was actually
   * requested and does not claim an immutable pinned version.
   */
  model?: string;
  /** The approval instruction in effect for this evaluation. */
  instruction: string;
  /** SHA-256 fingerprint of the exact call the evaluation covered. */
  argsFingerprint: string;
  evaluatedAt: string;
}

export interface IntegrationToolApprovalMetadata {
  approvalId: string;
  integrationId: string;
  toolName: string;
  argsSummary: unknown;
  status: IntegrationToolApprovalStatus;
  /**
   * Present only for `auto`-gated calls: the shadow recommendation recorded
   * while the human decision was still required (and remains required).
   */
  shadowEvaluation?: IntegrationToolApprovalShadowEvaluation;
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
  /** Only meaningful for `auto`; cleared for other modes. */
  instruction: z.string().max(2000).optional(),
});
export type IntegrationToolPolicyUpsert = z.infer<
  typeof integrationToolPolicyUpsertSchema
>;

/**
 * Unambiguous composite key for one (integration, tool) policy entry. A
 * delimiter-joined string would let distinct pairs collide (for example
 * `a`/`bc` and `ab`/`c`), which would apply one tool's configured mode to a
 * different tool.
 */
export function integrationToolPolicyKey(
  integrationId: string,
  toolName: string,
): string {
  return JSON.stringify([integrationId, toolName]);
}
