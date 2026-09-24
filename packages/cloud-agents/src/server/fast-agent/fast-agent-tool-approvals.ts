import { createHash } from 'node:crypto';

import type { PermissionRuleset } from '@opencode-ai/sdk/v2/client';
import {
  and,
  claimAutoApprovedIntegrationToolApproval,
  db,
  eq,
  expireIntegrationToolApproval,
  fingerprintIntegrationToolCall,
  getIntegrationToolApproval,
  getSessionForFastConversation,
  insertAutoApprovedIntegrationToolApproval,
  insertAutoRejectedIntegrationToolApproval,
  insertIntegrationToolApproval,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
  markIntegrationToolApprovalConsumed,
  sessionTasks,
} from '@roomote/db/server';
import { isSessionUserPresent } from '@roomote/redis';
import {
  integrationToolModeIsAutoAssessed,
  integrationToolPolicyKey,
  resolveEffectiveIntegrationToolMode,
  resolveGoverningIntegrationToolPolicies,
  redactIntegrationToolArgs,
  type FastAgentSurface,
  type IntegrationToolApprovalMetadata,
  type IntegrationToolPolicyMetadata,
  type IntegrationToolSessionOverrideMetadata,
} from '@roomote/types';

import {
  describeIntegrationToolAutoDeny,
  resolveIntegrationToolAutoDecision,
  resolveIntegrationToolAutoState,
} from '../integration-tool-auto-evaluation';
import type { FastAgentIntegration } from './fast-agent-integration-broker';
import { buildFastAgentCodeModeServerNames } from './fast-agent-tool-policy';

/**
 * Per-tool approvals for code-mode integration calls in sessions.
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
const SESSION_PRESENCE_LOOKUP_TIMEOUT_MS = 2_000;

async function isFastAgentLaunchedTask(
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const [association] = await db
    .select({ taskId: sessionTasks.taskId })
    .from(sessionTasks)
    .where(
      and(
        eq(sessionTasks.sessionId, sessionId),
        eq(sessionTasks.taskId, taskId),
        eq(sessionTasks.origin, 'fast_delegation'),
      ),
    )
    .limit(1);
  return association !== undefined;
}

type FastAgentApprovalChatSurface = Extract<
  FastAgentSurface,
  'slack' | 'discord' | 'teams' | 'telegram'
>;

export function isFastAgentApprovalChatSurface(
  surface: FastAgentSurface,
): surface is FastAgentApprovalChatSurface {
  return (
    surface === 'slack' ||
    surface === 'discord' ||
    surface === 'teams' ||
    surface === 'telegram'
  );
}

/**
 * OpenCode flattens every MCP tool to `<server name>_<tool name>`. The server
 * name is the integration's code-mode mount name, which is the sanitized
 * integration id made unique across the mounted set.
 */
export function codeModeToolKey(serverName: string, toolName: string) {
  return `${serverName}_${toolName}`;
}

type MountedIntegrationTool = {
  integrationId: string;
  toolName: string;
  serverName: string;
  key: string;
  description?: string;
};

/** Every mounted tool with the native key and server name it runs under. */
function listMountedIntegrationTools(
  integrations: FastAgentIntegration[],
): MountedIntegrationTool[] {
  const serverNames = buildFastAgentCodeModeServerNames(
    integrations.map((integration) => integration.id),
  );
  return integrations.flatMap((integration) => {
    const serverName = serverNames.get(integration.id)!;
    return integration.tools.map((tool) => ({
      integrationId: integration.id,
      toolName: tool.name,
      serverName,
      key: codeModeToolKey(serverName, tool.name),
      description: tool.description,
    }));
  });
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
  sessionOverrides: IntegrationToolSessionOverrideMetadata[] = [],
  options: {
    /**
     * Auto mode on: every default tool asks natively too, so the bridge can
     * assess each call. Their policy keys are collected in `autoToolKeys`.
     */
    autoOn?: boolean;
    autoToolKeys?: Set<string>;
  } = {},
): PermissionRuleset {
  const modeByTool = new Map(
    policies.map((policy) => [
      integrationToolPolicyKey(policy.integrationId, policy.toolName),
      policy.mode,
    ]),
  );
  const overrideByTool = new Map(
    sessionOverrides.map((override) => [
      integrationToolPolicyKey(override.integrationId, override.toolName),
      override.mode,
    ]),
  );
  // Server names are unique, but both halves of a flattened key may contain
  // underscores, so two distinct tools can still share one native key (`a` /
  // `b_c` and `a_b` / `c`). A native rule cannot tell them apart, so the most
  // restrictive mode among them wins: a collision can only ever add an ask or
  // a block, never let a gated tool run ungated.
  const actionByKey = new Map<string, 'ask' | 'deny'>();
  for (const tool of listMountedIntegrationTools(integrations)) {
    const key = integrationToolPolicyKey(tool.integrationId, tool.toolName);
    const policyMode = modeByTool.get(key);
    const mode = resolveEffectiveIntegrationToolMode({
      policyMode,
      sessionOverrideMode: overrideByTool.get(key),
    });
    // A session `allow` over a deployment `ask` deliberately keeps the
    // native ask rule: the bridge answers those asks itself, so "don't ask
    // again this session" works mid-turn, never changes the compiled rules
    // (no instance dispose), and never relies on OpenCode's leaky native
    // `always`.
    const sessionOverrideMode = overrideByTool.get(key);
    const autoAssessed =
      options.autoOn === true &&
      integrationToolModeIsAutoAssessed({ policyMode, sessionOverrideMode });
    if (mode === 'reject') {
      actionByKey.set(tool.key, 'deny');
    } else if (
      (mode === 'ask' ||
        (mode === 'allow' && policyMode === 'ask') ||
        autoAssessed) &&
      actionByKey.get(tool.key) !== 'deny'
    ) {
      actionByKey.set(tool.key, 'ask');
      if (autoAssessed) options.autoToolKeys?.add(key);
    }
  }
  const rules: PermissionRuleset = [...actionByKey].map(
    ([permission, action]) => ({ permission, pattern: '*', action }),
  );
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
        readContent?: string;
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
  // One script can call the same tool more than once. Child calls are
  // recorded as they run, so the paused call is the most recent match, not
  // the first; showing the first would put an earlier call's arguments on
  // this ask's card and audit row.
  const child = [...(recovered.toolCalls ?? [])]
    .reverse()
    .find((entry) => entry.tool === dottedChildName);
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
  /** The Session whose requester-owned overrides layer on the policies. */
  sessionId?: string;
  /** The Session owner, whose personal policies tighten the deployment ones. */
  ownerUserId?: string;
}): Promise<
  | {
      rules: PermissionRuleset;
      hash: string;
      /** Policy keys of the tools that ask only because Auto mode is on. */
      autoToolKeys: Set<string>;
    }
  | undefined
> {
  const [policies, userPolicies, sessionOverrides, autoState] =
    await Promise.all([
      listIntegrationToolPolicies(),
      input.ownerUserId
        ? listIntegrationToolUserPolicies(input.ownerUserId)
        : Promise.resolve([]),
      input.sessionId
        ? listIntegrationToolSessionOverrides(input.sessionId)
        : Promise.resolve([]),
      resolveIntegrationToolAutoState(),
    ]);
  // The Session owner's personal policies layer on the deployment ones; see
  // `resolveGoverningIntegrationToolPolicies` for the rule.
  const governing = resolveGoverningIntegrationToolPolicies({
    deploymentPolicies: policies,
    userPolicies,
    scopeOf: (integrationId) =>
      input.integrations.find((integration) => integration.id === integrationId)
        ?.toolApprovalPolicyScope,
  });
  const autoToolKeys = new Set<string>();
  const rules = buildIntegrationToolApprovalRules(
    input.integrations,
    governing,
    sessionOverrides,
    { autoOn: autoState.mode === 'on', autoToolKeys },
  );
  return { rules, hash: hashIntegrationToolApprovalRules(rules), autoToolKeys };
}

/**
 * The Session approvals are recorded and decided under. Approval rows, their
 * ownership check, and the requester's decision route are all keyed on the
 * unified Session, not the Fast conversation that runs the turn. Without a
 * bound Session there is nowhere for the requester to decide, so the
 * conversation id is returned and the ownership check fails the ask closed.
 *
 * Only the Session owner can decide an approval, so approvals are recorded
 * for the owner even when a participant sent the turn, and the owner is
 * whose personal policies apply: otherwise a participant's turn in a shared
 * Session would pause a call nobody can approve. Without a bound owner the
 * acting user stands in as the decider, and the ownership check fails the
 * ask closed.
 */
export async function resolveFastAgentToolApprovalSession(
  fastConversationId: string,
  actingUserId: string,
): Promise<{
  sessionId: string;
  ownerUserId: string | undefined;
  deciderUserId: string;
}> {
  const session = await getSessionForFastConversation(db, fastConversationId);
  const ownerUserId = session?.ownerUserId ?? undefined;
  return {
    sessionId: session?.id ?? fastConversationId,
    ownerUserId,
    deciderUserId: ownerUserId ?? actingUserId,
  };
}

export function createFastAgentToolApprovalBridge(input: {
  sessionId: string;
  userId: string;
  surface: FastAgentSurface;
  integrations: FastAgentIntegration[];
  /**
   * Tools that ask only because Auto mode is on. Their asks are assessed
   * by the decision model; every other ask is a person's own choice.
   */
  autoToolKeys?: Set<string>;
  /** Resolve the latest human request for each Auto assessment; steers can arrive mid-turn. */
  resolveUserRequest?: () => string | undefined;
  /** Optional chat-surface notification for non-web conversations. */
  notify?: (approval: IntegrationToolApprovalMetadata) => Promise<void>;
  signal?: AbortSignal;
}) {
  type ToolIdentity = MountedIntegrationTool;
  const toolsByKey = new Map<string, ToolIdentity[]>();
  const toolByDottedName = new Map<string, ToolIdentity>();
  for (const tool of listMountedIntegrationTools(input.integrations)) {
    toolsByKey.set(tool.key, [...(toolsByKey.get(tool.key) ?? []), tool]);
    toolByDottedName.set(`${tool.serverName}.${tool.toolName}`, tool);
  }
  const handledRequestIds = new Set<string>();
  const notifiedApprovalIds = new Set<string>();

  const ownerIsPresent = async (): Promise<boolean> => {
    if (isFastAgentApprovalChatSurface(input.surface)) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        isSessionUserPresent({
          sessionId: input.sessionId,
          userId: input.userId,
        }),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => {
            console.warn(
              `[Fast Agent] Presence lookup timed out for Session ${input.sessionId}; asking defensively.`,
            );
            resolve(true);
          }, SESSION_PRESENCE_LOOKUP_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      console.warn(
        `[Fast Agent] Presence lookup failed for Session ${input.sessionId}; asking defensively: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

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
      const argsSummary = redactIntegrationToolArgs(args ?? null);
      const argsFingerprint = fingerprintIntegrationToolCall({
        integrationId: tool.integrationId,
        toolName: tool.toolName,
        args: args ?? null,
      });
      // "Don't ask again this session": read fresh on every ask so the
      // requester's choice applies to the very next call, even mid-turn. The
      // audit row is written before the relay; if it cannot be written the
      // outer handler rejects the ask instead of running it unrecorded.
      const sessionOverrides = await listIntegrationToolSessionOverrides(
        input.sessionId,
      );
      const overrideForSession = sessionOverrides.find(
        (override) =>
          override.integrationId === tool.integrationId &&
          override.toolName === tool.toolName,
      )?.mode;
      const allowedForSession = overrideForSession === 'allow';
      // Auto mode: a call to a default tool is risk-assessed, and a routine
      // one runs without a card. A tool someone made a choice about (a
      // stored mode or a session override) is theirs to decide, so it never
      // reaches the model. A risky or unavailable assessment asks the Session
      // owner when present and is denied when they are away.
      const autoAssessed =
        !overrideForSession &&
        input.autoToolKeys?.has(
          integrationToolPolicyKey(tool.integrationId, tool.toolName),
        ) === true;
      const auto = autoAssessed
        ? await resolveIntegrationToolAutoDecision({
            integrationId: tool.integrationId,
            toolName: tool.toolName,
            toolDescription: tool.description,
            args,
            userRequest: input.resolveUserRequest?.(),
            readContent: recovered?.readContent,
            isSessionLaunchedTask: (taskId) =>
              isFastAgentLaunchedTask(input.sessionId, taskId),
            userId: input.userId,
          }).catch(() => ({
            action: 'ask' as const,
            mode: 'on' as const,
            evaluation: {
              recommendation: 'ask' as const,
              unavailable: 'error' as const,
              evaluatedAt: new Date().toISOString(),
            },
          }))
        : undefined;
      // A default tool asked under a rule compiled while Auto was on, after
      // Auto went off: it runs as it always has, and there is nothing to
      // record.
      if (auto?.mode === 'off') {
        await helpers.reply(ask.requestId, 'once');
        return;
      }
      if (auto?.action === 'ask' && !(await ownerIsPresent())) {
        // The audit row is born terminal `auto_rejected` with the assessment;
        // if it cannot be written the outer handler rejects the ask instead
        // of denying it unrecorded. No card is shown while the owner is away.
        await insertAutoRejectedIntegrationToolApproval(
          { sessionId: input.sessionId, userId: input.userId },
          {
            integrationId: tool.integrationId,
            toolName: tool.toolName,
            nativeRequestId: ask.requestId,
            argsFingerprint,
            argsSummary,
            autoEvaluation: auto.evaluation,
          },
        );
        await helpers
          .reply(
            ask.requestId,
            'reject',
            `Auto mode blocked this tool call because ${describeIntegrationToolAutoDeny(
              auto.evaluation,
            )} and the session owner was away. The call was not run. The session owner can allow this tool from its call in the transcript.`,
          )
          .catch(() => undefined);
        return;
      }
      if (allowedForSession || auto?.action === 'approve') {
        // The audit row starts as an unrelayed `approved` decision; claiming
        // it is the atomic reservation. The claim reads the experiment under
        // a share lock in its own transaction, so it serializes against the
        // toggle: a disable that committed first fails the claim (whether or
        // not its sweep has run yet, and even for a row written after the
        // sweep), and a disable that arrives later waits for the claim. The
        // ask therefore never relays after the final experiment state, and
        // no auto_approved record exists for a call that did not run.
        const reservation = await insertAutoApprovedIntegrationToolApproval(
          { sessionId: input.sessionId, userId: input.userId },
          {
            integrationId: tool.integrationId,
            toolName: tool.toolName,
            nativeRequestId: ask.requestId,
            argsFingerprint,
            argsSummary,
            ...(auto?.action === 'approve'
              ? { decidedBy: 'model' as const, autoEvaluation: auto.evaluation }
              : {}),
          },
        );
        const claimed = await claimAutoApprovedIntegrationToolApproval({
          approvalId: reservation.approvalId,
          requesterUserId: input.userId,
        });
        if (!claimed) {
          await helpers
            .reply(
              ask.requestId,
              'reject',
              'Tool approvals were disabled; the call was not run.',
            )
            .catch(() => undefined);
          return;
        }
        await helpers.reply(ask.requestId, 'once');
        return;
      }
      const approval = await insertIntegrationToolApproval(
        { sessionId: input.sessionId, userId: input.userId },
        {
          integrationId: tool.integrationId,
          toolName: tool.toolName,
          nativeRequestId: ask.requestId,
          argsFingerprint,
          argsSummary,
          ...(auto?.action === 'ask'
            ? { autoEvaluation: auto.evaluation }
            : {}),
        },
      );
      if (input.notify && !notifiedApprovalIds.has(approval.approvalId)) {
        notifiedApprovalIds.add(approval.approvalId);
        await input.notify(approval);
      }
      const deadline = Date.parse(approval.expiresAt);
      for (;;) {
        if (input.signal?.aborted) return;
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
          if (consumed) {
            // An undeliverable `once` is not swallowed: it reaches the
            // failure handler below, which rejects the ask so the session is
            // never left paused on a call that cannot be resumed.
            await helpers.reply(ask.requestId, 'once', undefined);
            return;
          }
          await helpers
            .reply(
              ask.requestId,
              'reject',
              'The approval for this tool call is no longer valid.',
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
