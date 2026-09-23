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
  /** The default: no row. Runs, and under Auto mode is risk-assessed first. */
  'allow',
  /** A stored choice to run without any assessment; Auto never looks. */
  'always_allow',
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
  // Ran without a card: the requester had chosen "don't ask again this
  // session" for the tool, or Auto mode's decision model approved the call
  // (then `decidedByUserId` is null). Its own status for the audit trail.
  'auto_approved',
  // Blocked without a card: Auto mode asked, but the Session owner was away.
  // Born terminal; `decidedByUserId` is null.
  'auto_rejected',
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
  /** Auto mode's assessment of the call, on the rows it decided. */
  autoEvaluation?: IntegrationToolAutoEvaluation;
  /** When this approval stops accepting a decision and fails closed. */
  expiresAt: string;
  createdAt: string;
}

/**
 * Deployment-wide Auto mode. `on`: every call to a tool nobody has made a
 * choice about (the default mode) is risk-assessed by the decision model
 * first; a routine call runs, anything else asks the Session owner when they
 * are present and is blocked with a tool error when they are away. A manual
 * choice always wins: Always allow is never assessed, Ask first always asks,
 * Reject always blocks. `off`: default tools run as they always have. While
 * off, and only with a hosted judgment model configured, the assessment still
 * runs in the background and is recorded, so its judgment can be checked
 * against real calls before it is turned on.
 */
export const INTEGRATION_TOOL_AUTO_MODES = ['off', 'on'] as const;
export type IntegrationToolAutoMode =
  (typeof INTEGRATION_TOOL_AUTO_MODES)[number];
export const INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH = 4_000;

export interface IntegrationToolAutoSettings {
  mode: IntegrationToolAutoMode;
  /**
   * The deployment's risk guidance: what it treats as routine or risky, in
   * the admin's words. The model reads it as context for its risk judgment,
   * not as rules to apply.
   */
  policy: string;
}

export const integrationToolAutoSettingsSchema = z.object({
  // An earlier preview stored a `shadow` mode; it reads as off.
  mode: z.preprocess(
    (value) => (value === 'shadow' ? 'off' : value),
    z.enum(INTEGRATION_TOOL_AUTO_MODES),
  ),
  policy: z.string().max(INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH),
});

/**
 * A decision model's risk assessment of one Auto-gated call, recorded on the
 * call's audit row. In shadow mode it decides nothing. The assessment can
 * recommend running the call or asking its owner.
 */
export interface IntegrationToolAutoEvaluation {
  recommendation: 'approve' | 'ask';
  /**
   * The raw judgments the recommendation was computed from: the risk level
   * (`riskScore`, a weighted position on the ordered risk levels, with
   * `riskConfidence`) and yes-probabilities for the rest.
   */
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

export const integrationToolPoliciesUpsertSchema = z.object({
  integrationId: z.string().min(1).max(200),
  toolNames: z.array(z.string().min(1).max(200)).min(1).max(500),
  mode: integrationToolPolicyModeSchema,
});
export type IntegrationToolPoliciesUpsert = z.infer<
  typeof integrationToolPoliciesUpsertSchema
>;

const INTEGRATION_TOOL_POLICY_MODE_STRICTNESS: Record<
  IntegrationToolPolicyMode,
  number
> = { always_allow: 0, allow: 0, ask: 1, reject: 2 };

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
 * Whether Auto mode, when on, assesses a call to a tool in this effective
 * mode: only the default. Every stored choice, and a session override, is a
 * person's decision that Auto leaves alone.
 */
export function integrationToolModeIsAutoAssessed(input: {
  policyMode: IntegrationToolPolicyMode | undefined;
  sessionOverrideMode: IntegrationToolSessionOverrideMode | undefined;
}): boolean {
  return (
    input.policyMode === undefined && input.sessionOverrideMode === undefined
  );
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
  permission: Record<string, 'allow' | 'ask' | 'deny'>;
  tools: Record<string, { integrationId: string; toolName: string }>;
  /**
   * Servers whose every tool asks natively because Auto mode is on. An ask
   * for a key outside `tools` is one of these; the worker names the tool
   * from the key, and the server decides who answers.
   */
  autoServers: string[];
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
  /** Auto mode on: every default tool asks natively, `<server>_*`. */
  autoOn?: boolean;
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
  const result: TaskIntegrationToolApprovals = {
    permission: {},
    tools: {},
    autoServers: [],
  };
  if (input.autoOn) {
    // Wildcards first: a tool's own rule below wins over its server's.
    for (const serverName of input.serverNames) {
      result.permission[`${openCodeMcpToolKey(serverName, '')}*`] = 'ask';
      result.autoServers.push(serverName);
    }
  }
  const ambiguous = new Set<string>();
  for (const { integrationId, toolName } of [
    ...input.policies,
    ...input.sessionOverrides,
  ]) {
    if (!mounted.has(integrationId)) continue;
    const policyKey = integrationToolPolicyKey(integrationId, toolName);
    const policyMode = policyModes.get(policyKey);
    const mode = resolveEffectiveIntegrationToolMode({
      policyMode,
      sessionOverrideMode: overrideModes.get(policyKey),
    });
    const action =
      mode === 'reject'
        ? 'deny'
        : mode === 'ask' || policyMode === 'ask'
          ? 'ask'
          : // A session `allow` over an ask policy keeps the native ask.
            input.autoOn
            ? // A stored Always allow, or a session allow, opts out of Auto.
              'allow'
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
