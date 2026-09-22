import { z } from 'zod';

import { isInternalMcpServer } from './custom-mcp-servers';

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
  'auto',
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
  /** The task whose agent asked; null when the Session's own agent did. */
  taskId: string | null;
  /** When this approval stops accepting a decision and fails closed. */
  expiresAt: string;
  createdAt: string;
}

/**
 * A decision model's view of one paused call to a tool in `auto` mode. While
 * Auto is a preview it is only recorded next to the requester's own decision,
 * so the two can be compared; it never approves or rejects anything. The
 * model can only ever recommend running the call or asking, never rejecting.
 */
export interface IntegrationToolAutoEvaluation {
  recommendation: 'approve' | 'ask';
  /** Probability from 0 to 1 that each question's answer is yes. */
  answers?: Record<string, number>;
  /** Why there are no answers: nothing could evaluate the call. */
  unavailable?: 'no_model' | 'error';
  evaluatedAt: string;
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
> = { allow: 0, auto: 1, ask: 2, reject: 3 };

/**
 * `auto` is `ask` with a second opinion: every call still pauses for the
 * Session owner, and a decision model's view of the call is recorded next to
 * their answer. It gates exactly like `ask` everywhere a call is held.
 */
export function integrationToolModeAsks(
  mode: IntegrationToolPolicyMode | undefined,
): boolean {
  return mode === 'ask' || mode === 'auto';
}

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
      // Internal MCPs (Roomote's own server, the HTTP integrations broker,
      // Brain memory) are never governed: approval policy is for deployment
      // integrations, and gating product infrastructure would pause the
      // product itself.
      if (isInternalMcpServer(policy.integrationId)) continue;
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

/**
 * What a task's worker needs to make its agent ask: the native permission
 * rules for its OpenCode configuration, and which integration tool each
 * gated native key stands for, so an ask can be recorded against the real
 * tool. Advisory inside the sandbox; the integration proxy is the boundary.
 */
export interface TaskIntegrationToolApprovals {
  permission: Record<string, 'ask' | 'deny'>;
  tools: Record<string, { integrationId: string; toolName: string }>;
}

/** OpenCode names an MCP tool `<server>_<tool>`, each half sanitized. */
function openCodeMcpToolKey(serverName: string, toolName: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${sanitize(serverName)}_${sanitize(toolName)}`;
}

/**
 * Compile the governing policies and the Session's overrides into a task's
 * native rules. Only `ask` and `deny` are emitted; allow is the absence of a
 * rule. A session `allow` over an `ask` policy keeps the native ask, which is
 * then answered without a card, exactly as in a Session. Two tools that
 * flatten to one native key cannot be told apart by a native rule, so that
 * key is denied rather than asked about under the wrong tool's name.
 */
export function compileTaskIntegrationToolApprovals(input: {
  serverNames: string[];
  policies: IntegrationToolPolicyEntry[];
  sessionOverrides: IntegrationToolSessionOverrideMetadata[];
}): TaskIntegrationToolApprovals {
  const mounted = new Set(input.serverNames);
  const policyModes = new Map(
    input.policies.map((policy) => [
      integrationToolPolicyKey(policy.integrationId, policy.toolName),
      policy.mode,
    ]),
  );
  const overrideModes = new Map(
    input.sessionOverrides.map((override) => [
      integrationToolPolicyKey(override.integrationId, override.toolName),
      override.mode,
    ]),
  );
  const result: TaskIntegrationToolApprovals = { permission: {}, tools: {} };
  const ambiguous = new Set<string>();
  for (const { integrationId, toolName } of [
    ...input.policies,
    ...input.sessionOverrides,
  ]) {
    if (!mounted.has(integrationId)) continue;
    // Internal MCPs are outside approval control entirely (see
    // `resolveGoverningIntegrationToolPolicies`).
    if (isInternalMcpServer(integrationId)) continue;
    const policyKey = integrationToolPolicyKey(integrationId, toolName);
    const policyMode = policyModes.get(policyKey);
    const mode = resolveEffectiveIntegrationToolMode({
      policyMode,
      sessionOverrideMode: overrideModes.get(policyKey),
    });
    const action =
      mode === 'reject'
        ? 'deny'
        : integrationToolModeAsks(mode) || integrationToolModeAsks(policyMode)
          ? 'ask'
          : undefined;
    if (!action) continue;
    const key = openCodeMcpToolKey(integrationId, toolName);
    const known = result.tools[key];
    if (
      known &&
      (known.integrationId !== integrationId || known.toolName !== toolName)
    ) {
      ambiguous.add(key);
    }
    result.tools[key] = { integrationId, toolName };
    if (result.permission[key] !== 'deny') result.permission[key] = action;
  }
  for (const key of ambiguous) {
    result.permission[key] = 'deny';
    delete result.tools[key];
  }
  return result;
}
