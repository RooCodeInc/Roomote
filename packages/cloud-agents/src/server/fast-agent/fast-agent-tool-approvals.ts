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
  isIntegrationToolAutoSuspendedForSession,
  listIntegrationToolPolicies,
  hasRejectedIntegrationToolInSession,
  listRecentIntegrationToolApprovalOutcomes,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
  markIntegrationToolApprovalConsumed,
  sessionTasks,
  suspendIntegrationToolAutoForSession,
} from '@roomote/db/server';
import { isSessionUserPresent } from '@roomote/redis';
import {
  waitForIntegrationToolApproval,
  type IntegrationToolApprovalWaitResult,
} from '@roomote/sdk/tool-approval-wait';
import {
  INTEGRATION_TOOL_AUTO_PAUSED_AGENT_MESSAGE,
  describeIntegrationToolAutoAbsentDenial,
  integrationToolModeIsAutoAssessed,
  integrationToolPolicyKey,
  resolveEffectiveIntegrationToolMode,
  resolveGoverningIntegrationToolPolicies,
  redactIntegrationToolArgs,
  type FastAgentSurface,
  type IntegrationToolApprovalMetadata,
  type IntegrationToolAutoEvaluation,
  type IntegrationToolPolicyMetadata,
  type IntegrationToolSessionOverrideMetadata,
} from '@roomote/types';

import {
  describeIntegrationToolAutoDeny,
  resolveIntegrationToolAutoDecision,
  resolveIntegrationToolAutoState,
  type IntegrationToolAutoOwner,
  type IntegrationToolAutoSessionContext,
  type IntegrationToolAutoToolResult,
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
type CardDecision = IntegrationToolApprovalWaitResult;
const SESSION_PRESENCE_LOOKUP_TIMEOUT_MS = 2_000;
/**
 * An open session page renews its presence every 10 seconds, and a page that
 * just opened can briefly drop it. The owner counts as away only when a
 * second lookup, a full renewal later, still finds nobody.
 */
const SESSION_PRESENCE_RECHECK_MS = 11_000;

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
 * cached agent state is rebuilt from the freshly rewritten tool config.
 * OpenCode's own servers are disposable child processes: after a Roomote
 * restart there is no live instance, and the next turn boots from the current
 * config. A dispose is therefore only needed when this process previously
 * booted the instance with a different fingerprint (`recordedHash` set and
 * unequal). An unknown record after a restart is fresh state, not stale state,
 * and must not dispose — that would be a false-positive cache break.
 */
export function shouldDisposeInstanceForToolConfig(input: {
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
        toolCalls?: Array<{
          tool?: unknown;
          input?: unknown;
          status?: unknown;
        }>;
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
/** A child call that has not finished, so an ask can be for it. */
function isOpenChildCall(entry: { status?: unknown }): boolean {
  return entry.status !== 'completed' && entry.status !== 'error';
}

/**
 * The arguments of the call an ask paused, or every argument set it could be.
 * A code-mode script can call the same tool more than once, and every ask it
 * raises carries the same outer call id. Only calls still running can be the
 * paused one: one such call, or several with identical arguments, identifies
 * the arguments. Several with different arguments (calls started together,
 * such as with `Promise.all`) cannot be told apart, so the caller gets all of
 * them rather than a guess that would show and assess another call.
 */
export function extractApprovalCallArgs(
  recovered:
    | {
        input?: unknown;
        toolCalls?: Array<{
          tool?: unknown;
          input?: unknown;
          status?: unknown;
        }>;
      }
    | undefined,
  tool: { serverName: string; toolName: string },
): { args: unknown; concurrent?: number } | { candidates: unknown[] } {
  if (!recovered) return { args: undefined };
  const dottedChildName = `${tool.serverName}.${tool.toolName}`;
  const matches = (recovered.toolCalls ?? []).filter(
    (entry) => entry.tool === dottedChildName,
  );
  if (matches.length === 0) return { args: recovered.input };
  const open = matches.filter(isOpenChildCall);
  // Nothing still running: the most recent call is the paused one.
  const candidates = open.length > 0 ? open : matches.slice(-1);
  const distinct = new Map<string, unknown>();
  for (const entry of candidates) {
    distinct.set(JSON.stringify(entry.input ?? null), entry.input);
  }
  return distinct.size === 1
    ? {
        args: candidates[0]!.input,
        ...(candidates.length > 1 ? { concurrent: candidates.length } : {}),
      }
    : { candidates: [...distinct.values()] };
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
      resolveIntegrationToolAutoState({ sessionId: input.sessionId }),
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
  resolveUserRequest?: () => string | undefined | Promise<string | undefined>;
  /** Human-authored request history from this Session, never a parent task. */
  resolveSessionUserMessages?: () => string[] | Promise<string[]>;
  /**
   * What the agent said before the owner's latest message, so Auto can tell
   * what a reply such as "yes, go ahead" agreed to. Human turns only.
   */
  resolveAgentMessageRepliedTo?: () => Promise<string | undefined>;
  /**
   * Results of integration tools the agent ran recently in this session,
   * oldest first, so Auto can tell what an identifier in a call refers to.
   */
  resolveRecentToolResults?: () => Promise<IntegrationToolAutoToolResult[]>;
  /**
   * Who the session owner is, when they wrote every message in the session,
   * so Auto can tell a call that names them from one that names somebody else.
   */
  resolveSessionOwner?: () => Promise<IntegrationToolAutoOwner | undefined>;
  /** Optional chat-surface notification for non-web conversations. */
  notify?: (approval: IntegrationToolApprovalMetadata) => Promise<void>;
  /**
   * Auto stopped for this session because a call could not be assessed:
   * tell the owner in the thread and end the turn. Called once per turn.
   */
  onAutoSuspended?: (tool: {
    integrationId: string;
    integrationName: string;
    toolName: string;
  }) => Promise<void>;
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
  // Calls running together in one script raise one ask each, and an ask may
  // not say which of them it is. Sharing one assessment per call (script,
  // tool, arguments) keeps their decisions the same; otherwise one ask could
  // refuse and fail the whole script.
  const sharedAssessments = new Map<
    string,
    ReturnType<typeof resolveIntegrationToolAutoDecision>
  >();
  // Parallel calls that need a person share one card listing all of them:
  // allowing it runs the whole batch, rejecting it stops the whole batch.
  const batchCards = new Map<string, Promise<CardDecision>>();

  /**
   * Record one approval card, notify chat surfaces, and wait for the
   * owner's decision. An approved card is consumed here, once, before any
   * call runs.
   */
  const awaitCardDecision = async (card: {
    tool: MountedIntegrationTool;
    nativeRequestId: string;
    argsFingerprint: string;
    argsSummary: unknown;
    autoEvaluation?: IntegrationToolAutoEvaluation;
  }): Promise<CardDecision> => {
    const approval = await insertIntegrationToolApproval(
      { sessionId: input.sessionId, userId: input.userId },
      {
        integrationId: card.tool.integrationId,
        toolName: card.tool.toolName,
        nativeRequestId: card.nativeRequestId,
        argsFingerprint: card.argsFingerprint,
        argsSummary: card.argsSummary,
        ...(card.autoEvaluation ? { autoEvaluation: card.autoEvaluation } : {}),
      },
    );
    if (input.notify && !notifiedApprovalIds.has(approval.approvalId)) {
      notifiedApprovalIds.add(approval.approvalId);
      await input.notify(approval);
    }
    return waitForIntegrationToolApproval({
      readStatus: async () =>
        (await getIntegrationToolApproval(approval.approvalId))?.status ?? null,
      // Consume before relaying: only the first relay of an approved,
      // unclaimed decision reaches OpenCode; a cancelled or double-claimed
      // row fails closed instead of executing twice.
      claimApproved: () =>
        markIntegrationToolApprovalConsumed({
          approvalId: approval.approvalId,
          requesterUserId: input.userId,
        }),
      signal: input.signal,
      deadline: Date.parse(approval.expiresAt),
      expire: () => expireIntegrationToolApproval(approval.approvalId),
    });
  };
  // Once Auto stops in this turn the turn is ending: no other call runs or
  // leaves a card waiting.
  let autoSuspendedThisTurn = false;

  const ownerIsPresent = async (): Promise<boolean> => {
    if (isFastAgentApprovalChatSurface(input.surface)) return true;
    if (await lookUpOwnerPresence()) return true;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, SESSION_PRESENCE_RECHECK_MS);
      timer.unref?.();
    });
    return lookUpOwnerPresence();
  };
  const lookUpOwnerPresence = async (): Promise<boolean> => {
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
          toolCalls?: Array<{
            tool?: unknown;
            input?: unknown;
            status?: unknown;
          }>;
        }
      | undefined,
  ):
    | {
        tool: ToolIdentity;
        args: unknown;
        /** Different calls running together; the ask could be any of them. */
        parallel?: unknown[];
        /** Identical calls running together, which share one decision. */
        concurrent?: boolean;
      }
    | { unresolved: 'identity' } => {
    const candidates = toolsByKey.get(permission) ?? [];
    if (candidates.length === 1) {
      const tool = candidates[0]!;
      const call = extractApprovalCallArgs(recovered, tool);
      return 'candidates' in call
        ? {
            tool,
            // A list, which tool arguments (always an object) never are.
            args: call.candidates,
            parallel: call.candidates,
          }
        : {
            tool,
            args: call.args,
            ...(call.concurrent ? { concurrent: true } : {}),
          };
    }
    const matchingChildren = (recovered?.toolCalls ?? []).filter(
      (entry) =>
        typeof entry.tool === 'string' &&
        flattenDottedChildName(entry.tool) === permission &&
        isOpenChildCall(entry),
    );
    if (matchingChildren.length === 1) {
      const child = matchingChildren[0]!;
      const tool = toolByDottedName.get(child.tool as string);
      if (tool) return { tool, args: child.input };
    }
    return { unresolved: 'identity' };
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
      if ('unresolved' in resolution) {
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
      const { tool, args, parallel, concurrent } = resolution;
      if (autoSuspendedThisTurn) {
        await helpers
          .reply(
            ask.requestId,
            'reject',
            INTEGRATION_TOOL_AUTO_PAUSED_AGENT_MESSAGE,
          )
          .catch(() => undefined);
        return;
      }
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
      const autoCandidate =
        !overrideForSession &&
        input.autoToolKeys?.has(
          integrationToolPolicyKey(tool.integrationId, tool.toolName),
        ) === true;
      // After Auto stopped for this session, its default tools ask a person.
      const autoSuspended =
        autoCandidate &&
        (await isIntegrationToolAutoSuspendedForSession(input.sessionId));
      // Auto turned off for the session since then: the tool runs as it
      // always has, like any default tool asked under a stale rule.
      if (
        autoSuspended &&
        (await resolveIntegrationToolAutoState({ sessionId: input.sessionId }))
          .mode !== 'on'
      ) {
        await helpers.reply(ask.requestId, 'once');
        return;
      }
      const autoAssessed = autoCandidate && !autoSuspended;
      const [
        recentUserMessages,
        explicitApprovalOutcomes,
        agentMessage,
        toolRejectedInSession,
        recentToolResults,
        owner,
      ] = autoAssessed
        ? await Promise.all([
            input.resolveSessionUserMessages?.() ?? [],
            // This query is keyed to this Session and owner, and excludes
            // task approvals and model decisions. A lookup failure removes
            // historical context; it cannot authorize a call by itself.
            listRecentIntegrationToolApprovalOutcomes({
              sessionId: input.sessionId,
              userId: input.userId,
            }).catch(() => []),
            // Context only: a lookup failure means "go ahead" covers nothing.
            input.resolveAgentMessageRepliedTo?.().catch(() => undefined),
            // A lookup failure counts as a rejection, so Auto asks.
            hasRejectedIntegrationToolInSession({
              sessionId: input.sessionId,
              userId: input.userId,
              integrationId: tool.integrationId,
              toolName: tool.toolName,
            }).catch(() => true),
            // Evidence only. A failed lookup supplies none, so a call that
            // names an identifier nothing else shows asks. Undefined when
            // this bridge was not given a way to read results at all.
            input.resolveRecentToolResults?.().catch(() => []),
            // Context only: a failed lookup leaves the owner unnamed.
            input.resolveSessionOwner?.().catch(() => undefined),
          ])
        : [[], [], undefined, false, undefined, undefined];
      const sessionContext: IntegrationToolAutoSessionContext | undefined =
        autoAssessed
          ? {
              ...(owner ? { owner } : {}),
              recentUserMessages,
              explicitApprovalOutcomes,
              ...(agentMessage ? { agentMessageRepliedTo: agentMessage } : {}),
              ...(toolRejectedInSession ? { toolRejectedInSession } : {}),
              ...(recentToolResults ? { recentToolResults } : {}),
            }
          : undefined;
      const assess = async (callArgs: unknown) =>
        resolveIntegrationToolAutoDecision({
          integrationId: tool.integrationId,
          toolName: tool.toolName,
          toolDescription: tool.description,
          args: callArgs,
          userRequest: await input.resolveUserRequest?.(),
          sessionContext,
          readContent: recovered?.readContent,
          isSessionLaunchedTask: (taskId) =>
            isFastAgentLaunchedTask(input.sessionId, taskId),
          userId: input.userId,
          sessionId: input.sessionId,
        }).catch(() => ({
          action: 'ask' as const,
          mode: 'on' as const,
          evaluation: {
            recommendation: 'ask' as const,
            unavailable: 'error' as const,
            evaluatedAt: new Date().toISOString(),
          },
        }));
      const assessShared = (callArgs: unknown) => {
        const key = JSON.stringify([
          ask.callId ?? ask.requestId,
          tool.integrationId,
          tool.toolName,
          callArgs ?? null,
        ]);
        let assessment = sharedAssessments.get(key);
        if (!assessment) {
          assessment = assess(callArgs);
          sharedAssessments.set(key, assessment);
          // Only calls waiting at the same time share it; a later call in
          // the same script is assessed again, with whatever changed since.
          void assessment.finally(() => sharedAssessments.delete(key));
        }
        return assessment;
      };
      let auto: Awaited<ReturnType<typeof assess>> | undefined;
      if (autoAssessed && parallel) {
        // This ask is one of these calls; it runs only if every one of them
        // would run on its own.
        const results = await Promise.all(parallel.map(assessShared));
        // Any call Auto could not check pauses Auto; any call it would not
        // run makes the batch ask the owner.
        auto =
          results.find((result) => result.mode === 'off') ??
          results.find(
            (result) => result.mode === 'on' && result.evaluation.unavailable,
          ) ??
          results.find((result) => result.action !== 'approve') ??
          results[0];
      } else if (autoAssessed) {
        auto = await assessShared(args);
      }
      // A default tool asked under a rule compiled while Auto was on, after
      // Auto went off: it runs as it always has, and there is nothing to
      // record.
      if (auto?.mode === 'off') {
        await helpers.reply(ask.requestId, 'once');
        return;
      }
      if (auto?.evaluation.unavailable) {
        // Calls in one turn run concurrently; only the first to get here
        // posts the notice. No await between the check and the set.
        const firstToPause = !autoSuspendedThisTurn;
        // The call could not be assessed: stop Auto for this session rather
        // than ask about (or deny) every call while assessment is down.
        autoSuspendedThisTurn = true;
        await suspendIntegrationToolAutoForSession(input.sessionId);
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
            INTEGRATION_TOOL_AUTO_PAUSED_AGENT_MESSAGE,
          )
          .catch(() => undefined);
        if (!firstToPause) return;
        await input
          .onAutoSuspended?.({
            integrationId: tool.integrationId,
            integrationName:
              input.integrations.find(
                (integration) => integration.id === tool.integrationId,
              )?.name ?? tool.integrationId,
            toolName: tool.toolName,
          })
          .catch((error: unknown) => {
            console.warn(
              `[Fast Agent] Could not post the Auto pause notice for session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return;
      }
      // The owner may have rejected a call to this tool while this one was
      // being assessed (two calls in flight together). Check again right
      // before running so that rejection still makes this call ask.
      if (
        auto?.mode === 'on' &&
        auto.action === 'approve' &&
        !toolRejectedInSession &&
        (await hasRejectedIntegrationToolInSession({
          sessionId: input.sessionId,
          userId: input.userId,
          integrationId: tool.integrationId,
          toolName: tool.toolName,
        }).catch(() => true))
      ) {
        auto = {
          ...auto,
          action: 'ask',
          evaluation: {
            ...auto.evaluation,
            recommendation: 'ask',
            reason: 'the session owner rejected a call to this tool',
          },
        };
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
            describeIntegrationToolAutoAbsentDenial(
              describeIntegrationToolAutoDeny(auto.evaluation),
            ),
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
        // An Auto approval loses to a rejection of this tool that commits
        // before the claim, even one made after the check above.
        const guardRejection =
          !allowedForSession &&
          auto?.action === 'approve' &&
          !toolRejectedInSession;
        const claimed = await claimAutoApprovedIntegrationToolApproval({
          approvalId: reservation.approvalId,
          requesterUserId: input.userId,
          ...(guardRejection
            ? {
                unlessToolRejected: {
                  sessionId: input.sessionId,
                  integrationId: tool.integrationId,
                  toolName: tool.toolName,
                },
              }
            : {}),
        });
        if (!claimed) {
          await helpers
            .reply(
              ask.requestId,
              'reject',
              guardRejection
                ? 'The call was not run: tool approvals were disabled, or the session owner just rejected a call to this tool. Ask them before trying it again.'
                : 'Tool approvals were disabled; the call was not run.',
            )
            .catch(() => undefined);
          return;
        }
        await helpers.reply(ask.requestId, 'once');
        return;
      }
      const card = {
        tool,
        nativeRequestId: ask.requestId,
        argsFingerprint,
        argsSummary,
        ...(auto?.action === 'ask' ? { autoEvaluation: auto.evaluation } : {}),
      };
      let decision: CardDecision;
      if (parallel || concurrent) {
        const batchKey = JSON.stringify([
          ask.callId ?? ask.requestId,
          tool.integrationId,
          tool.toolName,
          parallel ?? [args ?? null],
        ]);
        let shared = batchCards.get(batchKey);
        if (!shared) {
          shared = awaitCardDecision(card);
          batchCards.set(batchKey, shared);
          // A decided card never covers calls that start later.
          void shared.finally(() => batchCards.delete(batchKey));
        }
        decision = await shared;
      } else {
        decision = await awaitCardDecision(card);
      }
      if (decision === 'aborted') return;
      if (decision === 'approved') {
        // An undeliverable `once` is not swallowed: it reaches the failure
        // handler below, which rejects the ask so the session is never left
        // paused on a call that cannot be resumed.
        await helpers.reply(ask.requestId, 'once', undefined);
        return;
      }
      await helpers
        .reply(
          ask.requestId,
          'reject',
          decision === 'expired'
            ? 'The requester did not answer in time; the tool call was not run.'
            : decision === 'invalid'
              ? 'The approval for this tool call is no longer valid.'
              : 'The requester rejected this tool call.',
        )
        .catch(() => undefined);
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
