import { createHash } from 'node:crypto';

import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import type {
  IntegrationToolApprovalMetadata,
  IntegrationToolApprovalShadowEvaluation,
  IntegrationToolPolicyMetadata,
  IntegrationToolPolicyMode,
} from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import {
  integrationToolApprovalRequests,
  integrationToolPolicies,
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
  row: IntegrationToolPolicyRow,
): IntegrationToolPolicyMetadata {
  return {
    policyId: row.id,
    integrationId: row.integrationId,
    toolName: row.toolName,
    mode: row.mode,
    ...(row.instruction ? { instruction: row.instruction } : {}),
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
    ...(row.shadowEvaluation ? { shadowEvaluation: row.shadowEvaluation } : {}),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every configured policy, keyed for both the admin settings surface and the
 * per-turn permission compilation. Rows with mode `allow` are not stored:
 * deleting the row restores the default, which keeps this list small and
 * makes policy removal the same operation as setting the default.
 */
export async function listIntegrationToolPolicies(): Promise<
  IntegrationToolPolicyMetadata[]
> {
  const rows = await db
    .select()
    .from(integrationToolPolicies)
    .orderBy(
      integrationToolPolicies.integrationId,
      integrationToolPolicies.toolName,
    );
  return rows.map(policyMetadata);
}

/**
 * Configure one tool's approval mode. `allow` is the deployment default and
 * is stored as no row at all, so "reset to default" and "remove policy" are
 * the same write. Only `ask` and `reject` rows exist.
 */
export async function upsertIntegrationToolPolicy(input: {
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
  /** Only meaningful for `auto`; stored as NULL for other modes. */
  instruction?: string;
  updatedByUserId: string;
}): Promise<void> {
  if (input.mode === 'allow') {
    await db
      .delete(integrationToolPolicies)
      .where(
        and(
          eq(integrationToolPolicies.integrationId, input.integrationId),
          eq(integrationToolPolicies.toolName, input.toolName),
        ),
      );
    return;
  }
  const instruction =
    input.mode === 'auto' && input.instruction?.trim()
      ? input.instruction.trim()
      : null;
  await db
    .insert(integrationToolPolicies)
    .values({
      integrationId: input.integrationId,
      toolName: input.toolName,
      mode: input.mode,
      instruction,
      updatedByUserId: input.updatedByUserId,
      updatedAt: sql`clock_timestamp()`,
    })
    .onConflictDoUpdate({
      target: [
        integrationToolPolicies.integrationId,
        integrationToolPolicies.toolName,
      ],
      set: {
        mode: input.mode,
        instruction,
        updatedByUserId: input.updatedByUserId,
        updatedAt: sql`clock_timestamp()`,
      },
    });
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
    /**
     * Advisory shadow evaluation for `auto`-gated calls, bound to this
     * request's `argsFingerprint`. Recorded alongside the pending row so the
     * eventual human decision on the same row stays correlated with what the
     * evaluator would have recommended. Never authorizes the call.
     */
    shadowEvaluation?: IntegrationToolApprovalShadowEvaluation;
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
        integrationId: input.integrationId,
        toolName: input.toolName,
        nativeRequestId: input.nativeRequestId,
        argsFingerprint: input.argsFingerprint,
        argsSummary: redactIntegrationToolArgs(input.argsSummary),
        ...(input.shadowEvaluation
          ? { shadowEvaluation: input.shadowEvaluation }
          : {}),
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
  input: { approvalId: string; decision: 'approved' | 'rejected' },
): Promise<IntegrationToolApprovalMetadata> {
  const [row] = await db
    .update(integrationToolApprovalRequests)
    .set({
      status: input.decision,
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
  return approvalMetadata(row);
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
  const [row] = await db
    .update(integrationToolApprovalRequests)
    .set({ status: 'consumed' })
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

export {
  approvalMetadata as integrationToolApprovalMetadata,
  policyMetadata as integrationToolPolicyMetadata,
};
export type { IntegrationToolApprovalRow, IntegrationToolPolicyRow };
