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
import {
  integrationToolPolicyKey,
  type IntegrationToolApprovalMetadata,
  type IntegrationToolPolicyMetadata,
} from '@roomote/types';

import type { FastAgentIntegration } from './fast-agent-integration-broker';
import { buildFastAgentCodeModeServerNames } from './fast-agent-tool-policy';

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

/** OpenCode flattens every MCP tool to `<server name>_<tool name>`. */
export function codeModeToolKey(serverName: string, toolName: string) {
  return `${serverName}_${toolName}`;
}

/**
 * The collision-safe server names for this turn's mounted integrations,
 * shared with the config writer so approval rules, mounting, and the ask
 * bridge all name tools identically.
 */
function integrationToolServerNames(
  integrations: FastAgentIntegration[],
): Map<string, string> {
  return buildFastAgentCodeModeServerNames(
    integrations.map((integration) => integration.id),
  );
}

/**
 * Server names are made unique per integration, but the flattened tool key
 * (`<server name>_<tool name>`) can still collide across distinct
 * integration/tool pairs because both halves may contain underscores
 * (`a`/`b_c` and `a_b`/`c` both become `a_b_c`). Returns every flattened
 * key claimed by more than one pair. Approval enforcement cannot resolve
 * identity for those keys, so they are failed closed (denied outright)
 * instead of being allowed to execute under another tool's policy.
 */
function findCollidingIntegrationToolKeys(
  integrations: FastAgentIntegration[],
): string[] {
  const serverNames = integrationToolServerNames(integrations);
  const pairsByKey = new Map<string, Set<string>>();
  for (const integration of integrations) {
    const serverName = serverNames.get(integration.id)!;
    for (const tool of integration.tools) {
      const key = codeModeToolKey(serverName, tool.name);
      const pairs = pairsByKey.get(key) ?? new Set<string>();
      pairs.add(`${integration.id}/${tool.name}`);
      pairsByKey.set(key, pairs);
    }
  }
  return [...pairsByKey.entries()]
    .filter(([, pairs]) => pairs.size > 1)
    .map(([key]) => key)
    .sort();
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
  const serverNames = integrationToolServerNames(integrations);
  const collidingKeys = new Set(findCollidingIntegrationToolKeys(integrations));
  const modeByTool = new Map(
    policies.map((policy) => [
      integrationToolPolicyKey(policy.integrationId, policy.toolName),
      policy.mode,
    ]),
  );
  const rules: PermissionRuleset = [];
  for (const integration of integrations) {
    const serverName = serverNames.get(integration.id)!;
    for (const tool of integration.tools) {
      const key = codeModeToolKey(serverName, tool.name);
      if (collidingKeys.has(key)) continue;
      const mode = modeByTool.get(
        integrationToolPolicyKey(integration.id, tool.name),
      );
      if (mode === 'ask') {
        rules.push({ permission: key, pattern: '*', action: 'ask' });
      } else if (mode === 'reject') {
        rules.push({ permission: key, pattern: '*', action: 'deny' });
      }
    }
  }
  // Fail closed on ambiguous keys: OpenCode evaluates last-match-wins, so
  // these denies beat any configured rule for the same key. An ambiguous
  // call can never execute ungated, and no tool inherits another's policy.
  for (const key of collidingKeys) {
    rules.push({ permission: key, pattern: '*', action: 'deny' });
  }
  return rules;
}

/**
 * Compile the same rules into OpenCode's config-permission shape for the
 * generated per-conversation `opencode.json` (`agent.<name>.permission`),
 * which is how gated rules reach the parent build agent and the helper
 * subagents without touching session-creation state.
 */
export function integrationToolApprovalRulesToConfig(
  rules: PermissionRuleset,
): Record<string, 'ask' | 'deny'> {
  return Object.fromEntries(
    rules.map((rule) => [rule.permission, rule.action]),
  ) as Record<string, 'ask' | 'deny'>;
}

/**
 * Whether the live per-directory OpenCode instance must be disposed so its
 * cached agent state is rebuilt from the freshly rewritten config. Approval
 * rules ride in the generated per-conversation config, which every turn
 * rewrites, and OpenCode's own servers are disposable child processes: after
 * a Roomote restart there is no live instance at all, and the next turn's
 * instance boots from the current config. A dispose is therefore only needed
 * when the same process previously booted the instance with different rules
 * (`recordedHash` set and unequal). An unknown record after a restart is
 * fresh state, not stale state, and must not dispose — that would be a
 * false-positive cache break.
 */
export function shouldDisposeInstanceForToolApprovalRules(input: {
  recordedHash: string | null | undefined;
  currentHash: string | null;
}): boolean {
  if (input.recordedHash === undefined) return false;
  return input.recordedHash !== input.currentHash;
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
  tool: { serverName: string; toolName: string },
): unknown {
  if (!recovered) return undefined;
  const dottedChildName = `${tool.serverName}.${tool.toolName}`;
  const child = recovered.toolCalls?.find(
    (entry) => entry.tool === dottedChildName,
  );
  return child ? child.input : recovered.input;
}

/**
 * Load and compile the approval rules for one turn. Returns undefined only
 * when the experiment is off, which keeps today's ungated behavior. When
 * distinct integration tools flatten to the same native key, those keys are
 * denied outright (fail closed) so an ambiguous call can never execute
 * under another tool's policy; unaffected tools keep their configured
 * modes. Policies are read fresh each turn; the caller compares the
 * returned hash against the hash the live instance booted with and
 * refreshes on drift.
 */
export async function resolveFastAgentToolApprovalRules(input: {
  integrations: FastAgentIntegration[];
}): Promise<{ rules: PermissionRuleset; hash: string } | undefined> {
  const enabled = await isDeploymentExperimentEnabled(
    'integrationToolApprovals',
  );
  if (!enabled) return undefined;
  const collidingKeys = findCollidingIntegrationToolKeys(input.integrations);
  if (collidingKeys.length > 0) {
    console.warn(
      `[Fast Agent] Tool approvals: denying ambiguous OpenCode tool names (${collidingKeys.join(', ')}) because distinct integration tools flatten to them.`,
    );
  }
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
  const serverNames = integrationToolServerNames(input.integrations);
  type ToolIdentity = {
    integrationId: string;
    serverName: string;
    toolName: string;
  };
  const toolsByKey = new Map<string, ToolIdentity[]>();
  const toolByDottedName = new Map<string, ToolIdentity>();
  for (const integration of input.integrations) {
    const serverName = serverNames.get(integration.id)!;
    for (const tool of integration.tools) {
      const identity: ToolIdentity = {
        integrationId: integration.id,
        serverName,
        toolName: tool.name,
      };
      const key = codeModeToolKey(serverName, tool.name);
      toolsByKey.set(key, [...(toolsByKey.get(key) ?? []), identity]);
      toolByDottedName.set(`${serverName}.${tool.name}`, identity);
    }
  }
  const handledRequestIds = new Set<string>();
  const notifiedApprovalIds = new Set<string>();

  // A code-mode child call's dotted name (`server.tool`) is unambiguous even
  // when its flattened permission key (`server_tool`) is not, so it is the
  // identity source for colliding keys. Flattening replaces the first dot.
  const flattenDottedChildName = (dotted: string) => {
    const boundary = dotted.indexOf('.');
    return boundary === -1
      ? dotted
      : `${dotted.slice(0, boundary)}_${dotted.slice(boundary + 1)}`;
  };

  /**
   * Resolve which mounted tool an ask is really for. A unique flattened key
   * resolves directly. A colliding key resolves only through the paused
   * call's own child-tool record; without it the identity is unknowable and
   * the ask must fail closed rather than display or audit the wrong tool.
   */
  const resolveToolForAsk = (
    permission: string,
    recovered:
      | {
          input?: unknown;
          toolCalls?: Array<{ tool?: unknown; input?: unknown }>;
        }
      | undefined,
  ): { tool: ToolIdentity; args: unknown } | null => {
    const candidates = toolsByKey.get(permission) ?? [];
    if (candidates.length === 1) {
      const tool = candidates[0]!;
      return { tool, args: extractApprovalCallArgs(recovered, tool) };
    }
    const matchingChildren = (recovered?.toolCalls ?? []).filter(
      (entry) =>
        typeof entry.tool === 'string' &&
        flattenDottedChildName(entry.tool) === permission,
    );
    if (matchingChildren.length === 1) {
      const child = matchingChildren[0]!;
      const tool = toolByDottedName.get(child.tool as string);
      if (tool) return { tool, args: child.input };
    }
    return null;
  };

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
      const resolution = resolveToolForAsk(ask.permission, recovered);
      if (!resolution) {
        // Never show the requester a card for a different tool than the one
        // that would execute, and never let an ambiguous call through.
        console.warn(
          `[Fast Agent] Tool approval ask ${ask.requestId} for ${ask.permission} has an ambiguous tool identity; failing closed.`,
        );
        await helpers
          .reply(
            ask.requestId,
            'reject',
            'The approval identity of this tool call is ambiguous; the call was not run.',
          )
          .catch(() => undefined);
        return;
      }
      const { tool, args } = resolution;
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
          // The experiment may have been disabled since this iteration's
          // top-level check; never relay an execution under a disabled
          // experiment. The cancellation sweep also marks the row cancelled,
          // which makes the consume below fail closed as well.
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
