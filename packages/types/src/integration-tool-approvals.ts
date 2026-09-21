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
 *
 * A user can also keep personal policies for their own Sessions. Those use
 * the same modes and only ever tighten: the stricter of the deployment and
 * personal mode applies, so a personal `allow` never loosens an admin `ask`.
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
  // Relayed without a card because the requester chose "don't ask again this
  // session" for the tool; kept as its own status for the audit trail.
  'auto_approved',
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

/**
 * Requester-owned, session-scoped override of one tool's effective approval
 * mode. `allow` stops the asks for a tool whose deployment policy is `ask`
 * ("don't ask again this session"); `ask` gates a tool the deployment leaves
 * at the default allow. A deployment `reject` is a ceiling no override can
 * loosen, and overrides never outlive or leave their session.
 */
export const INTEGRATION_TOOL_SESSION_OVERRIDE_MODES = [
  'allow',
  'ask',
] as const;
export type IntegrationToolSessionOverrideMode =
  (typeof INTEGRATION_TOOL_SESSION_OVERRIDE_MODES)[number];

export interface IntegrationToolSessionOverrideMetadata {
  integrationId: string;
  toolName: string;
  mode: IntegrationToolSessionOverrideMode;
}

export interface IntegrationToolApprovals {
  pending: IntegrationToolApprovalMetadata[];
  sessionOverrides: IntegrationToolSessionOverrideMetadata[];
}

export const integrationToolApprovalDecisionSchema = z.object({
  approvalId: z.string().uuid(),
  /** `approved_for_session` approves this call and stops asking for the tool. */
  decision: z.enum(['approved', 'approved_for_session', 'rejected']),
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

export const integrationToolSessionOverrideUpsertSchema = z.object({
  integrationId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  /** `null` clears the override and restores the deployment policy. */
  mode: z.enum(INTEGRATION_TOOL_SESSION_OVERRIDE_MODES).nullable(),
});
export type IntegrationToolSessionOverrideUpsert = z.infer<
  typeof integrationToolSessionOverrideUpsertSchema
>;

const INTEGRATION_TOOL_POLICY_MODE_STRICTNESS: Record<
  IntegrationToolPolicyMode,
  number
> = { allow: 0, ask: 1, reject: 2 };

/** The stricter of a tool's deployment policy and the requester's own. */
function resolveStricterIntegrationToolPolicyMode(
  deploymentMode: IntegrationToolPolicyMode | undefined,
  userMode: IntegrationToolPolicyMode | undefined,
): IntegrationToolPolicyMode | undefined {
  if (!deploymentMode) return userMode;
  if (!userMode) return deploymentMode;
  return INTEGRATION_TOOL_POLICY_MODE_STRICTNESS[userMode] >
    INTEGRATION_TOOL_POLICY_MODE_STRICTNESS[deploymentMode]
    ? userMode
    : deploymentMode;
}

/** Which policy layers govern an integration; unset means both. */
export type IntegrationToolPolicyScope = 'deployment' | 'personal';

type IntegrationToolPolicyEntry = Pick<
  IntegrationToolPolicyMetadata,
  'integrationId' | 'toolName' | 'mode'
>;

/**
 * The one rule for combining policy layers, shared by every enforcement
 * point (the Session runtime and the integration proxy): per tool, the
 * stricter mode among the layers that govern its integration.
 *
 * A custom server is governed by one layer only, matching where its policies
 * are edited: a shared server takes the deployment's, a personal server its
 * owner's. Their names can coincide, so a policy written for one must never
 * reach the other. Built-in integrations (no scope) take both layers.
 */
export function resolveGoverningIntegrationToolPolicies<
  T extends IntegrationToolPolicyEntry,
>(input: {
  deploymentPolicies: T[];
  userPolicies: T[];
  scopeOf: (integrationId: string) => IntegrationToolPolicyScope | undefined;
}): T[] {
  const governing = new Map<string, T>();
  for (const [layer, policies] of [
    ['deployment', input.deploymentPolicies],
    ['personal', input.userPolicies],
  ] as const) {
    for (const policy of policies) {
      if ((input.scopeOf(policy.integrationId) ?? layer) !== layer) continue;
      const key = integrationToolPolicyKey(
        policy.integrationId,
        policy.toolName,
      );
      const mode = resolveStricterIntegrationToolPolicyMode(
        governing.get(key)?.mode,
        policy.mode,
      );
      if (mode === policy.mode) governing.set(key, policy);
    }
  }
  return [...governing.values()];
}

/**
 * The mode a tool actually runs under in one session. `policyMode` is the
 * stricter of the deployment and personal policy. A deployment `reject`
 * always wins; otherwise the session override, then the deployment policy,
 * then the default allow.
 */
export function resolveEffectiveIntegrationToolMode(input: {
  policyMode: IntegrationToolPolicyMode | undefined;
  sessionOverrideMode: IntegrationToolSessionOverrideMode | undefined;
}): IntegrationToolPolicyMode {
  if (input.policyMode === 'reject') return 'reject';
  return input.sessionOverrideMode ?? input.policyMode ?? 'allow';
}

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
