import { createHash } from 'node:crypto';

import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import type {
  IntegrationToolApprovalMetadata,
  IntegrationToolAutoEvaluation,
  IntegrationToolPolicyMetadata,
  IntegrationToolPolicyMode,
  IntegrationToolSessionOverrideMetadata,
  IntegrationToolSessionOverrideMode,
} from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import { isDeploymentExperimentEnabledWithShareLock } from './deployment-experiments';
import {
  integrationToolApprovalRequests,
  integrationToolPolicies,
  integrationToolUserPolicies,
  integrationToolSessionOverrides,
  sessions,
  users,
} from '../schema';

/**
 * How long the requester has to answer an approval before it fails closed.
 * Short enough that a stalled turn does not wait on a forgotten card.
 */
export const INTEGRATION_TOOL_APPROVAL_WINDOW_MINUTES = 10;

export class IntegrationToolApprovalUnavailableError extends Error {
  readonly reason: 'owner_not_found' | 'approval_not_found' | 'write_failed';

  constructor(reason: IntegrationToolApprovalUnavailableError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

/** Stable JSON: object keys sorted recursively so equal calls hash equally. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function fingerprintIntegrationToolCall(input: {
  integrationId: string;
  toolName: string;
  args: unknown;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex');
}

const SECRET_KEY_PATTERN =
  /secret|token|password|api[-_]?key|authorization|credential|private[-_]?key/i;
const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 6;

/**
 * Display/audit preview of tool-call arguments. Secret-looking values and
 * oversized strings never reach the database or the UI; the approver still
 * sees the call's shape and ordinary arguments.
 */
export function redactIntegrationToolArgs(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => redactIntegrationToolArgs(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          SECRET_KEY_PATTERN.test(key)
            ? '[redacted]'
            : redactIntegrationToolArgs(item, depth + 1),
        ]),
    );
  }
  return value;
}

type IntegrationToolPolicyRow = typeof integrationToolPolicies.$inferSelect;
type IntegrationToolApprovalRow =
  typeof integrationToolApprovalRequests.$inferSelect;

function policyMetadata(
  row: Pick<
    IntegrationToolPolicyRow,
    | 'id'
    | 'integrationId'
    | 'toolName'
    | 'mode'
    | 'auto'
    | 'updatedAt'
    | 'createdAt'
  >,
): IntegrationToolPolicyMetadata {
  return {
    policyId: row.id,
    integrationId: row.integrationId,
    toolName: row.toolName,
    mode: row.mode === 'ask' && row.auto ? 'auto' : row.mode,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function approvalMetadata(
  row: IntegrationToolApprovalRow,
): IntegrationToolApprovalMetadata {
  return {
    approvalId: row.id,
    integrationId: row.integrationId,
    toolName: row.toolName,
    argsSummary: row.argsSummary,
    status: row.status,
    taskId: row.taskId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The deployment and personal policy tables share one shape and one set of
 * rules: rows with mode `allow` are not stored, so deleting the row restores
 * the default and "reset to default" is the same write as "remove policy".
 * Only `ask` and `reject` rows exist. A store names the table, the rows it
 * owns, and the columns only that table has.
 */
function deploymentPolicyStore(updatedByUserId?: string) {
  const table = integrationToolPolicies;
  return {
    table,
    owns: undefined,
    conflictTarget: [table.integrationId, table.toolName],
    ownValues: updatedByUserId ? { updatedByUserId } : {},
    keyValues: {},
  };
}

function userPolicyStore(userId: string) {
  const table = integrationToolUserPolicies;
  return {
    table,
    owns: eq(table.userId, userId),
    conflictTarget: [table.userId, table.integrationId, table.toolName],
    ownValues: {},
    keyValues: { userId },
  };
}

type PolicyStore =
  | ReturnType<typeof deploymentPolicyStore>
  | ReturnType<typeof userPolicyStore>;

async function listPolicies(
  store: PolicyStore,
): Promise<IntegrationToolPolicyMetadata[]> {
  const { table } = store;
  const rows = await db
    .select()
    .from(table as typeof integrationToolPolicies)
    .where(store.owns)
    .orderBy(table.integrationId, table.toolName);
  return rows.map(policyMetadata);
}

async function upsertPolicy(
  store: PolicyStore,
  input: {
    integrationId: string;
    toolName: string;
    mode: IntegrationToolPolicyMode;
  },
): Promise<void> {
  // Both tables have every column this writes; the store supplies the rest.
  const table = store.table as typeof integrationToolPolicies;
  if (input.mode === 'allow') {
    await db
      .delete(table)
      .where(
        and(
          store.owns,
          eq(table.integrationId, input.integrationId),
          eq(table.toolName, input.toolName),
        ),
      );
    return;
  }
  // `auto` is stored as `ask` with a flag, so a release that predates it
  // still asks about the tool instead of reading an unknown mode as allow.
  const changes = {
    mode: input.mode === 'auto' ? ('ask' as const) : input.mode,
    auto: input.mode === 'auto',
    ...store.ownValues,
    updatedAt: sql`clock_timestamp()`,
  };
  await db
    .insert(table)
    .values({
      ...store.keyValues,
      integrationId: input.integrationId,
      toolName: input.toolName,
      ...changes,
    })
    .onConflictDoUpdate({ target: store.conflictTarget, set: changes });
}

/**
 * Every deployment policy, for both the admin settings surface and the
 * per-turn permission compilation.
 */
export function listIntegrationToolPolicies() {
  return listPolicies(deploymentPolicyStore());
}

/** Configure one tool's deployment-wide approval mode. */
export function upsertIntegrationToolPolicy(input: {
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
  updatedByUserId: string;
}) {
  return upsertPolicy(deploymentPolicyStore(input.updatedByUserId), input);
}

/** One user's personal policies. */
export function listIntegrationToolUserPolicies(userId: string) {
  return listPolicies(userPolicyStore(userId));
}

/**
 * Configure one tool's approval mode for the user's own Sessions. It layers
 * on the deployment policy and never loosens it; see
 * `resolveStricterIntegrationToolPolicyMode`.
 */
export function upsertIntegrationToolUserPolicy(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
}) {
  return upsertPolicy(userPolicyStore(input.userId), input);
}

async function requireSessionOwner(
  tx: DatabaseOrTransaction,
  context: { sessionId: string; userId: string },
) {
  const [owner] = await tx
    .select({ id: users.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerUserId))
    .where(eq(sessions.id, context.sessionId))
    .for('share');
  if (!owner || owner.id !== context.userId) {
    throw new IntegrationToolApprovalUnavailableError('owner_not_found');
  }
  return owner;
}

/**
 * Insert the pending approval for one native permission request, or return
 * the identical open one: a repeated event for the same native request must
 * not stack duplicate cards or let a second decision authorize anything. The
 * partial unique index on (session, native request) for pending rows makes
 * this atomic under concurrent inserts.
 */
export async function insertIntegrationToolApproval(
  context: { sessionId: string; userId: string },
  input: {
    integrationId: string;
    toolName: string;
    nativeRequestId: string;
    argsFingerprint: string;
    argsSummary: unknown;
    /** Set when a task's agent asked; see `claimTaskIntegrationToolCall`. */
    taskId?: string;
  },
): Promise<IntegrationToolApprovalMetadata> {
  return db.transaction(async (tx) => {
    const owner = await requireSessionOwner(tx, context);
    const pendingWhere = and(
      eq(integrationToolApprovalRequests.sessionId, context.sessionId),
      eq(
        integrationToolApprovalRequests.nativeRequestId,
        input.nativeRequestId,
      ),
      eq(integrationToolApprovalRequests.status, 'pending'),
    );
    const [existing] = await tx
      .select()
      .from(integrationToolApprovalRequests)
      .where(pendingWhere)
      .for('share')
      .limit(1);
    if (existing) return approvalMetadata(existing);
    const [row] = await tx
      .insert(integrationToolApprovalRequests)
      .values({
        sessionId: context.sessionId,
        requesterUserId: owner.id,
        taskId: input.taskId ?? null,
        integrationId: input.integrationId,
        toolName: input.toolName,
        nativeRequestId: input.nativeRequestId,
        argsFingerprint: input.argsFingerprint,
        argsSummary: redactIntegrationToolArgs(input.argsSummary),
        expiresAt: sql`clock_timestamp() + ${INTEGRATION_TOOL_APPROVAL_WINDOW_MINUTES} * interval '1 minute'`,
      })
      .onConflictDoNothing({
        target: [
          integrationToolApprovalRequests.sessionId,
          integrationToolApprovalRequests.nativeRequestId,
        ],
        where: sql`status = 'pending'`,
      })
      .returning();
    if (!row) {
      const [winner] = await tx
        .select()
        .from(integrationToolApprovalRequests)
        .where(pendingWhere)
        .limit(1);
      if (!winner) {
        throw new IntegrationToolApprovalUnavailableError('write_failed');
      }
      return approvalMetadata(winner);
    }
    return approvalMetadata(row);
  });
}

/** Pending approvals the requester may still answer; expired rows fail closed and are hidden. */
export async function listPendingIntegrationToolApprovals(context: {
  sessionId: string;
  userId: string;
}): Promise<IntegrationToolApprovalMetadata[]> {
  const rows = await db
    .select()
    .from(integrationToolApprovalRequests)
    .where(
      and(
        eq(integrationToolApprovalRequests.sessionId, context.sessionId),
        eq(integrationToolApprovalRequests.requesterUserId, context.userId),
        eq(integrationToolApprovalRequests.status, 'pending'),
        gt(integrationToolApprovalRequests.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(integrationToolApprovalRequests.createdAt);
  return rows.map(approvalMetadata);
}

/** Executor-side read while waiting for the requester's decision. */
export async function getIntegrationToolApproval(
  approvalId: string,
  database: DatabaseOrTransaction = db,
): Promise<IntegrationToolApprovalRow | undefined> {
  return database.query.integrationToolApprovalRequests.findFirst({
    where: eq(integrationToolApprovalRequests.id, approvalId),
  });
}

/**
 * Requester-only decision. The conditional update is the whole authority
 * check: wrong approver, already-decided (duplicate response), and expired
 * rows all match zero rows and fail closed.
 */
export async function decideIntegrationToolApproval(
  context: { sessionId: string; userId: string },
  input: {
    approvalId: string;
    decision: 'approved' | 'approved_for_session' | 'rejected';
  },
): Promise<IntegrationToolApprovalMetadata> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(integrationToolApprovalRequests)
      .set({
        status: input.decision === 'rejected' ? 'rejected' : 'approved',
        decidedByUserId: context.userId,
        decidedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationToolApprovalRequests.id, input.approvalId),
          eq(integrationToolApprovalRequests.sessionId, context.sessionId),
          eq(integrationToolApprovalRequests.requesterUserId, context.userId),
          eq(integrationToolApprovalRequests.status, 'pending'),
          gt(integrationToolApprovalRequests.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!row) {
      throw new IntegrationToolApprovalUnavailableError('approval_not_found');
    }
    // "Don't ask again this session": the same authority check that accepted
    // this decision also records the session-scoped allow, so the override
    // can only ever come from the requester answering a real ask.
    if (input.decision === 'approved_for_session') {
      await upsertSessionOverride(tx, {
        sessionId: context.sessionId,
        integrationId: row.integrationId,
        toolName: row.toolName,
        mode: 'allow',
        setByUserId: context.userId,
      });
    }
    return approvalMetadata(row);
  });
}

/**
 * Claim an unrelayed `approved` row for relay, serialized against the
 * experiment toggle. Disabling commits `enabled=false` first and sweeps open
 * rows second, so a bare conditional update could still claim a row in
 * between and relay under a disabled experiment. Reading the setting with a
 * share lock in the same transaction closes that: either the disable already
 * committed and the claim fails, or the claim holds the lock and the disable
 * waits until the claim has committed — so the call was genuinely authorized
 * before the experiment went off. It also covers a row inserted after the
 * sweep already ran, which the sweep alone can never cancel.
 */
async function claimApprovedIntegrationToolApproval(
  input: { approvalId: string; requesterUserId: string },
  claimedStatus: 'consumed' | 'auto_approved',
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (
      !(await isDeploymentExperimentEnabledWithShareLock(
        'integrationToolApprovals',
        tx,
      ))
    ) {
      return false;
    }
    const [row] = await tx
      .update(integrationToolApprovalRequests)
      .set({ status: claimedStatus })
      .where(
        and(
          eq(integrationToolApprovalRequests.id, input.approvalId),
          eq(
            integrationToolApprovalRequests.requesterUserId,
            input.requesterUserId,
          ),
          eq(integrationToolApprovalRequests.status, 'approved'),
        ),
      )
      .returning({ id: integrationToolApprovalRequests.id });
    return Boolean(row);
  });
}

/**
 * Record that the approved decision was relayed to the native runtime and the
 * call resumed exactly once. Only an approved, unclaimed row transitions, so
 * a second relay attempt or a late relay after cancellation matches zero
 * rows and the caller fails the native ask closed instead.
 */
export async function markIntegrationToolApprovalConsumed(input: {
  approvalId: string;
  requesterUserId: string;
}): Promise<boolean> {
  return claimApprovedIntegrationToolApproval(input, 'consumed');
}

/** Record the decision model's view of a call to a tool in `auto` mode. */
export async function recordIntegrationToolAutoEvaluation(
  approvalId: string,
  autoEvaluation: IntegrationToolAutoEvaluation,
): Promise<void> {
  await db
    .update(integrationToolApprovalRequests)
    .set({ autoEvaluation })
    .where(eq(integrationToolApprovalRequests.id, approvalId));
}

/** Lazily fail an unanswered window closed; safe to call on any pending row. */
export async function expireIntegrationToolApproval(
  approvalId: string,
): Promise<void> {
  await db
    .update(integrationToolApprovalRequests)
    .set({ status: 'expired' })
    .where(
      and(
        eq(integrationToolApprovalRequests.id, approvalId),
        eq(integrationToolApprovalRequests.status, 'pending'),
      ),
    );
}

/**
 * Cancel every still-open approval (pending or approved-but-unclaimed) with a
 * recorded reason. Used when the experiment is disabled: in-flight asks fail
 * closed, approved-but-unrelayed decisions never execute, and a later
 * re-enable cannot resurrect these rows because cancelled is terminal.
 */
export async function cancelOpenIntegrationToolApprovals(
  reason: string,
): Promise<number> {
  const rows = await db
    .update(integrationToolApprovalRequests)
    .set({ status: 'cancelled', cancelReason: reason })
    .where(
      inArray(integrationToolApprovalRequests.status, ['pending', 'approved']),
    )
    .returning({ id: integrationToolApprovalRequests.id });
  return rows.length;
}

async function upsertSessionOverride(
  tx: DatabaseOrTransaction,
  input: {
    sessionId: string;
    integrationId: string;
    toolName: string;
    mode: IntegrationToolSessionOverrideMode;
    setByUserId: string;
  },
): Promise<void> {
  await tx
    .insert(integrationToolSessionOverrides)
    .values({ ...input, updatedAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({
      target: [
        integrationToolSessionOverrides.sessionId,
        integrationToolSessionOverrides.integrationId,
        integrationToolSessionOverrides.toolName,
      ],
      set: {
        mode: input.mode,
        setByUserId: input.setByUserId,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

/**
 * Every override in one session, for both the per-turn rule compilation and
 * the requester's transcript controls. Session-scoped by construction: no
 * caller can read or apply another session's rows through this.
 */
export async function listIntegrationToolSessionOverrides(
  sessionId: string,
): Promise<IntegrationToolSessionOverrideMetadata[]> {
  const rows = await db
    .select()
    .from(integrationToolSessionOverrides)
    .where(eq(integrationToolSessionOverrides.sessionId, sessionId))
    .orderBy(
      integrationToolSessionOverrides.integrationId,
      integrationToolSessionOverrides.toolName,
    );
  return rows.map((row) => ({
    integrationId: row.integrationId,
    toolName: row.toolName,
    mode: row.mode,
  }));
}

/** The requester's own view of their session's overrides; empty for anyone else. */
export async function listIntegrationToolSessionOverridesForRequester(context: {
  sessionId: string;
  userId: string;
}): Promise<IntegrationToolSessionOverrideMetadata[]> {
  const [owned] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, context.sessionId),
        eq(sessions.ownerUserId, context.userId),
      ),
    )
    .limit(1);
  return owned ? listIntegrationToolSessionOverrides(context.sessionId) : [];
}

/**
 * Requester-only write of one session override; `null` clears it and
 * restores the deployment policy. Only the Session owner may change how
 * their own session asks.
 */
export async function setIntegrationToolSessionOverride(
  context: { sessionId: string; userId: string },
  input: {
    integrationId: string;
    toolName: string;
    mode: IntegrationToolSessionOverrideMode | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireSessionOwner(tx, context);
    if (input.mode === null) {
      await tx
        .delete(integrationToolSessionOverrides)
        .where(
          and(
            eq(integrationToolSessionOverrides.sessionId, context.sessionId),
            eq(
              integrationToolSessionOverrides.integrationId,
              input.integrationId,
            ),
            eq(integrationToolSessionOverrides.toolName, input.toolName),
          ),
        );
      return;
    }
    await upsertSessionOverride(tx, {
      sessionId: context.sessionId,
      integrationId: input.integrationId,
      toolName: input.toolName,
      mode: input.mode,
      setByUserId: context.userId,
    });
  });
}

/**
 * Audit row for an ask the bridge relayed without a card because the
 * requester already chose "don't ask again this session" for the tool. It is
 * born terminal, so no later decision or relay can ever claim it.
 */
export async function insertAutoApprovedIntegrationToolApproval(
  context: { sessionId: string; userId: string },
  input: {
    integrationId: string;
    toolName: string;
    nativeRequestId: string;
    argsFingerprint: string;
    argsSummary: unknown;
    /** Set when a task's agent asked; see `claimTaskIntegrationToolCall`. */
    taskId?: string;
  },
): Promise<IntegrationToolApprovalMetadata> {
  return db.transaction(async (tx) => {
    const owner = await requireSessionOwner(tx, context);
    // The row starts as an unrelayed `approved` decision, exactly like a
    // requester click: the bridge claims it with a conditional transition
    // before relaying, so a mid-turn disable sweep cancels it instead of
    // leaving a terminal auto_approved record for a call that never ran.
    const [row] = await tx
      .insert(integrationToolApprovalRequests)
      .values({
        sessionId: context.sessionId,
        requesterUserId: owner.id,
        taskId: input.taskId ?? null,
        integrationId: input.integrationId,
        toolName: input.toolName,
        nativeRequestId: input.nativeRequestId,
        argsFingerprint: input.argsFingerprint,
        argsSummary: redactIntegrationToolArgs(input.argsSummary),
        status: 'approved',
        decidedByUserId: owner.id,
        decidedAt: sql`clock_timestamp()`,
        expiresAt: sql`clock_timestamp()`,
      })
      .returning();
    if (!row) throw new IntegrationToolApprovalUnavailableError('write_failed');
    return approvalMetadata(row);
  });
}

/**
 * Atomically claim an unrelayed auto-approval for relay: only an `approved`,
 * unclaimed row transitions to terminal `auto_approved`. The experiment
 * disable sweep cancels `approved` rows, so a sweep that lands first makes
 * this return false and the caller rejects the native ask instead of
 * executing — no auto_approved record ever exists for a call that did not
 * run, and no disable can slip between the claim and the relay decision.
 */
export async function claimAutoApprovedIntegrationToolApproval(input: {
  approvalId: string;
  requesterUserId: string;
}): Promise<boolean> {
  return claimApprovedIntegrationToolApproval(input, 'auto_approved');
}

/**
 * A task's gated call, at the integration proxy: claim the Session owner's
 * approval of this exact call. The agent's native ask is advisory inside a
 * sandbox, so the proxy is what makes Ask first real for a task: a call runs
 * only by consuming an approved row for the same task, tool, and arguments,
 * once. Serialized against the experiment toggle like every other claim.
 */
export async function claimTaskIntegrationToolCall(input: {
  taskId: string;
  argsFingerprint: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (
      !(await isDeploymentExperimentEnabledWithShareLock(
        'integrationToolApprovals',
        tx,
      ))
    ) {
      return false;
    }
    const [approved] = await tx
      .select({ id: integrationToolApprovalRequests.id })
      .from(integrationToolApprovalRequests)
      .where(
        and(
          eq(integrationToolApprovalRequests.taskId, input.taskId),
          eq(
            integrationToolApprovalRequests.argsFingerprint,
            input.argsFingerprint,
          ),
          eq(integrationToolApprovalRequests.status, 'approved'),
          // An approval answers the ask that was open then, not a call the
          // agent makes much later with the same arguments.
          gt(
            integrationToolApprovalRequests.decidedAt,
            sql`clock_timestamp() - ${INTEGRATION_TOOL_APPROVAL_WINDOW_MINUTES} * interval '1 minute'`,
          ),
        ),
      )
      .orderBy(integrationToolApprovalRequests.createdAt)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!approved) return false;
    await tx
      .update(integrationToolApprovalRequests)
      .set({ status: 'consumed' })
      .where(eq(integrationToolApprovalRequests.id, approved.id));
    return true;
  });
}

export {
  approvalMetadata as integrationToolApprovalMetadata,
  policyMetadata as integrationToolPolicyMetadata,
};
export type { IntegrationToolApprovalRow, IntegrationToolPolicyRow };
