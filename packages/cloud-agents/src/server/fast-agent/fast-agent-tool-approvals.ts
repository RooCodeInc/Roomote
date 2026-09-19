import { createHash } from 'node:crypto';

import type { PermissionRuleset } from '@opencode-ai/sdk/v2/client';
import {
  cancelOpenIntegrationToolApprovals,
  expireIntegrationToolApproval,
  fingerprintIntegrationToolCall,
  getIntegrationToolApproval,
  insertIntegrationToolApproval,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  markIntegrationToolApprovalConsumed,
} from '@roomote/db/server';
import type {
  IntegrationToolApprovalMetadata,
  IntegrationToolPolicyMetadata,
} from '@roomote/types';

import type { FastAgentIntegration } from './fast-agent-integration-broker';

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approvals for
 * code-mode integration calls in Fast sessions.
 *
 * Design notes:
 * - Policies compile into native OpenCode session permission rules (`ask` /
 *   `deny`). Durable "always allow" deliberately never maps to OpenCode's
 *   in-memory native `always`, which leaks across sessions on a shared
 *   server and dies on restart; the durable record lives in
 *   `integration_tool_policies` and is applied as ordinary allow by leaving
 *   no rule at all.
 * - Native asks carry the real MCP tool identity (`<server>_<tool>`) but no
 *   arguments, so the bridge correlates the ask's tool call against the
 *   OpenCode session messages to build the redacted-args approval card.
 * - Decisions are requester-owned rows in the database; this bridge is the
 *   only writer that relays them back to OpenCode (`once` / `reject`), so a
 *   double click, a restarted web process, or a second Roomote replica can
 *   never execute the same call twice. OpenCode consumes a native `once`
 *   per ask, which binds the approval to the exact paused call; a repeated
 *   call with changed arguments is a new ask by construction.
 */
const INTEGRATION_TOOL_APPROVAL_POLL_MS = 1_500;
const INTEGRATION_TOOL_APPROVAL_CANCEL_EXPERIMENT_DISABLED =
  'experiment_disabled';

/** OpenCode prefixes MCP tools with the sanitized server name. */
function sanitizeCodeModeIntegrationPrefix(integrationId: string) {
  return integrationId.replace(/[^a-zA-Z0-9_-]/gu, '_');
}

export function codeModeToolKey(integrationId: string, toolName: string) {
  return `${sanitizeCodeModeIntegrationPrefix(integrationId)}_${toolName}`;
}

/**
 * Compile configured policies into native session permission rules for the
 * integrations mounted this turn. Only tools the actor is actually
 * authorized to mount can produce rules, so a configured policy can never
 * expose a tool the provider/admin ceilings withheld. Tools without a policy
 * row keep OpenCode's default allow, which is the pre-experiment behavior.
 */
export function buildIntegrationToolApprovalRules(
  integrations: FastAgentIntegration[],
  policies: IntegrationToolPolicyMetadata[],
): PermissionRuleset {
  const modeByTool = new Map(
    policies.map((policy) => [
      `${policy.integrationId}${policy.toolName}`,
      policy.mode,
    ]),
  );
  const rules: PermissionRuleset = [];
  for (const integration of integrations) {
    for (const tool of integration.tools) {
      const mode = modeByTool.get(`${integration.id}${tool.name}`);
      if (mode === 'ask') {
        rules.push({
          permission: codeModeToolKey(integration.id, tool.name),
          pattern: '*',
          action: 'ask',
        });
      } else if (mode === 'reject') {
        rules.push({
          permission: codeModeToolKey(integration.id, tool.name),
          pattern: '*',
          action: 'deny',
        });
      }
    }
  }
  return rules;
}

/**
 * Fingerprint of the compiled rules for warm-session staleness detection.
 * OpenCode fixes a session's permission ruleset at creation, so a policy or
 * experiment change must rebuild the OpenCode session rather than silently
 * running under the previous turn's rules.
 */
export function hashIntegrationToolApprovalRules(
  rules: PermissionRuleset,
): string {
  const canonical = [...rules]
    .map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`)
    .sort();
  return createHash('sha256').update(canonical.join('\n')).digest('hex');
}

type FastAgentToolApprovalAsk = {
  requestId: string;
  sessionId: string;
  permission: string;
  messageId?: string;
  callId?: string;
};

type FastAgentToolApprovalHelpers = {
  /** Look up the paused call's arguments inside the asking OpenCode session. */
  fetchCallArgs: (input: {
    sessionId: string;
    messageId?: string;
    callId?: string;
  }) => Promise<
    | {
        input?: unknown;
        toolCalls?: Array<{ tool?: unknown; input?: unknown }>;
      }
    | undefined
  >;
  /** Relay the final decision to the native permission request. */
  reply: (
    requestId: string,
    response: 'once' | 'reject',
    message?: string,
  ) => Promise<void>;
};

/**
 * The arguments to show (redacted) on the approval card. Under code mode the
 * paused call is the outer `execute` script; its metadata names the child
 * tool calls with their structured inputs, so the card shows the gated
 * child call's own arguments. A plain MCP call shows its input directly.
 */
export function extractApprovalCallArgs(
  recovered:
    | {
        input?: unknown;
        toolCalls?: Array<{ tool?: unknown; input?: unknown }>;
      }
    | undefined,
  tool: { integrationId: string; toolName: string },
): unknown {
  if (!recovered) return undefined;
  const dottedChildName = `${sanitizeCodeModeIntegrationPrefix(tool.integrationId)}.${tool.toolName}`;
  const child = recovered.toolCalls?.find(
    (entry) => entry.tool === dottedChildName,
  );
  return child ? child.input : recovered.input;
}

/**
 * Load and compile the approval rules for one turn. Returns undefined when
 * the experiment is off or code mode is inactive so callers can skip every
 * approval concern. Policies are read fresh each turn; the caller compares
 * the returned hash against the hash the live OpenCode session was created
 * with and rebuilds on drift.
 */
export async function resolveFastAgentToolApprovalRules(input: {
  codeModeIntegrationsEffective: boolean;
  integrations: FastAgentIntegration[];
}): Promise<{ rules: PermissionRuleset; hash: string } | undefined> {
  if (!input.codeModeIntegrationsEffective) return undefined;
  const enabled = await isDeploymentExperimentEnabled(
    'integrationToolApprovals',
  );
  if (!enabled) return undefined;
  const policies = await listIntegrationToolPolicies();
  const rules = buildIntegrationToolApprovalRules(input.integrations, policies);
  return { rules, hash: hashIntegrationToolApprovalRules(rules) };
}

export function createFastAgentToolApprovalBridge(input: {
  sessionId: string;
  userId: string;
  integrations: FastAgentIntegration[];
  /** Optional chat-surface notification for non-web conversations. */
  notify?: (approval: IntegrationToolApprovalMetadata) => Promise<void>;
  signal?: AbortSignal;
}) {
  const toolByKey = new Map<
    string,
    { integrationId: string; toolName: string }
  >();
  for (const integration of input.integrations) {
    for (const tool of integration.tools) {
      toolByKey.set(codeModeToolKey(integration.id, tool.name), {
        integrationId: integration.id,
        toolName: tool.name,
      });
    }
  }
  const handledRequestIds = new Set<string>();
  const notifiedApprovalIds = new Set<string>();

  const resolveTool = (permission: string) => toolByKey.get(permission);

  /**
   * Handle one native `permission.asked` event: record the requester-facing
   * approval, notify chat surfaces, wait for the decision, and relay it to
   * OpenCode. Fire-and-forget from the event monitor; failures reject the
   * native ask so a bridge error never silently executes a gated call and
   * never wedges the turn on an unanswered permission.
   */
  const handleAsk = (
    ask: FastAgentToolApprovalAsk,
    helpers: FastAgentToolApprovalHelpers,
  ): void => {
    const tool = resolveTool(ask.permission);
    if (!tool) return;
    if (handledRequestIds.has(ask.requestId)) return;
    handledRequestIds.add(ask.requestId);
    void (async () => {
      const recovered = await helpers
        .fetchCallArgs({
          sessionId: ask.sessionId,
          ...(ask.messageId ? { messageId: ask.messageId } : {}),
          ...(ask.callId ? { callId: ask.callId } : {}),
        })
        .catch(() => undefined);
      const args = extractApprovalCallArgs(recovered, tool);
      const approval = await insertIntegrationToolApproval(
        { sessionId: input.sessionId, userId: input.userId },
        {
          integrationId: tool.integrationId,
          toolName: tool.toolName,
          nativeRequestId: ask.requestId,
          argsFingerprint: fingerprintIntegrationToolCall({
            integrationId: tool.integrationId,
            toolName: tool.toolName,
            args: args ?? null,
          }),
          argsSummary: args ?? null,
        },
      );
      if (input.notify && !notifiedApprovalIds.has(approval.approvalId)) {
        notifiedApprovalIds.add(approval.approvalId);
        await input.notify(approval);
      }
      const deadline = Date.parse(approval.expiresAt);
      for (;;) {
        if (input.signal?.aborted) return;
        // The experiment can be disabled while this ask is open. Fail the
        // native ask closed and leave a terminal, reasoned cancellation so a
        // later re-enable can never resurrect this grant.
        if (
          !(await isDeploymentExperimentEnabled('integrationToolApprovals'))
        ) {
          await cancelOpenIntegrationToolApprovals(
            INTEGRATION_TOOL_APPROVAL_CANCEL_EXPERIMENT_DISABLED,
          );
          await helpers
            .reply(
              ask.requestId,
              'reject',
              'Tool approvals were disabled; the call was not run.',
            )
            .catch(() => undefined);
          return;
        }
        const row = await getIntegrationToolApproval(approval.approvalId);
        if (!row || row.status === 'rejected' || row.status === 'cancelled') {
          await helpers
            .reply(
              ask.requestId,
              'reject',
              'The requester rejected this tool call.',
            )
            .catch(() => undefined);
          return;
        }
        if (row.status === 'expired') {
          await helpers
            .reply(
              ask.requestId,
              'reject',
              'The requester did not answer in time; the tool call was not run.',
            )
            .catch(() => undefined);
          return;
        }
        if (row.status === 'approved') {
          // Consume before relaying: only the first relay of an approved,
          // unclaimed decision reaches OpenCode; a cancelled or
          // double-claimed row fails closed instead of executing twice.
          const consumed = await markIntegrationToolApprovalConsumed({
            approvalId: approval.approvalId,
            requesterUserId: input.userId,
          });
          await helpers
            .reply(
              ask.requestId,
              consumed ? 'once' : 'reject',
              consumed
                ? undefined
                : 'The approval for this tool call is no longer valid.',
            )
            .catch(() => undefined);
          return;
        }
        if (Date.now() >= deadline) {
          await expireIntegrationToolApproval(approval.approvalId);
          await helpers
            .reply(
              ask.requestId,
              'reject',
              'The requester did not answer in time; the tool call was not run.',
            )
            .catch(() => undefined);
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, INTEGRATION_TOOL_APPROVAL_POLL_MS),
        );
      }
    })().catch((error) => {
      console.warn(
        `[Fast Agent] Tool approval bridge failed for ${ask.permission}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Never leave the native ask open after a bridge failure: a stranded
      // permission would stall the turn until the process dies.
      void helpers
        .reply(
          ask.requestId,
          'reject',
          'The approval for this tool call could not be completed.',
        )
        .catch(() => undefined);
    });
  };

  return { handleAsk };
}
