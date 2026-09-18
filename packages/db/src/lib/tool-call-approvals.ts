import { createHash } from 'node:crypto';

import { and, eq, gt, sql } from 'drizzle-orm';

import type { ToolCallApprovalMetadata } from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import { sessions, toolCallApprovals, users } from '../schema';

/**
 * How long the requester has to answer a tool-call approval before it fails
 * closed. Short enough that a stalled turn does not wait on a forgotten card.
 */
export const TOOL_CALL_APPROVAL_WINDOW_MINUTES = 10;

export class ToolCallApprovalUnavailableError extends Error {
  readonly reason: 'owner_not_found' | 'approval_not_found' | 'write_failed';

  constructor(reason: ToolCallApprovalUnavailableError['reason']) {
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

export function fingerprintToolCallArgs(input: {
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
export function redactToolCallArgs(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => redactToolCallArgs(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          SECRET_KEY_PATTERN.test(key)
            ? '[redacted]'
            : redactToolCallArgs(item, depth + 1),
        ]),
    );
  }
  return value;
}

type ToolCallApprovalRow = typeof toolCallApprovals.$inferSelect;

function metadata(row: ToolCallApprovalRow): ToolCallApprovalMetadata {
  return {
    approvalId: row.id,
    integrationId: row.integrationId,
    toolName: row.toolName,
    argsSummary: row.argsSummary,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
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
    throw new ToolCallApprovalUnavailableError('owner_not_found');
  }
  return owner;
}

/**
 * Insert the pending approval, or reuse the identical open one: a repeated
 * ask for the exact same call must not stack duplicate cards or let a second
 * decision authorize a second execution. The partial unique index on
 * (session, fingerprint) for pending rows makes this atomic: a concurrent
 * identical insert conflicts and the existing row is re-read.
 */
export async function insertToolCallApproval(
  context: { sessionId: string; userId: string },
  input: {
    integrationId: string;
    toolName: string;
    argsFingerprint: string;
    argsSummary: unknown;
  },
): Promise<ToolCallApprovalMetadata> {
  return db.transaction(async (tx) => {
    const owner = await requireSessionOwner(tx, context);
    // Expiry is lazy: a cancelled or restarted executor never marks its own
    // ask expired. Sweep the stale pending row for this exact call first so
    // it neither hides the fresh ask nor trips the pending uniqueness index.
    await tx
      .update(toolCallApprovals)
      .set({ status: 'expired' })
      .where(
        and(
          eq(toolCallApprovals.sessionId, context.sessionId),
          eq(toolCallApprovals.argsFingerprint, input.argsFingerprint),
          eq(toolCallApprovals.status, 'pending'),
          sql`${toolCallApprovals.expiresAt} <= clock_timestamp()`,
        ),
      );
    const pendingWhere = and(
      eq(toolCallApprovals.sessionId, context.sessionId),
      eq(toolCallApprovals.argsFingerprint, input.argsFingerprint),
      eq(toolCallApprovals.status, 'pending'),
      gt(toolCallApprovals.expiresAt, sql`clock_timestamp()`),
    );
    const [existing] = await tx
      .select()
      .from(toolCallApprovals)
      .where(pendingWhere)
      .for('share')
      .limit(1);
    if (existing) return metadata(existing);
    const [row] = await tx
      .insert(toolCallApprovals)
      .values({
        sessionId: context.sessionId,
        requesterUserId: owner.id,
        integrationId: input.integrationId,
        toolName: input.toolName,
        argsFingerprint: input.argsFingerprint,
        argsSummary: redactToolCallArgs(input.argsSummary),
        expiresAt: sql`clock_timestamp() + ${TOOL_CALL_APPROVAL_WINDOW_MINUTES} * interval '1 minute'`,
      })
      .onConflictDoNothing({
        target: [
          toolCallApprovals.sessionId,
          toolCallApprovals.argsFingerprint,
        ],
        where: sql`status = 'pending'`,
      })
      .returning();
    if (!row) {
      // Lost the race against an identical concurrent insert; the unique
      // pending index guarantees that row is the one to reuse.
      const [winner] = await tx
        .select()
        .from(toolCallApprovals)
        .where(pendingWhere)
        .limit(1);
      if (!winner) throw new ToolCallApprovalUnavailableError('write_failed');
      return metadata(winner);
    }
    return metadata(row);
  });
}

/** Pending approvals the requester may still answer; expired rows fail closed and are hidden. */
export async function listPendingToolCallApprovals(context: {
  sessionId: string;
  userId: string;
}): Promise<ToolCallApprovalMetadata[]> {
  const rows = await db
    .select()
    .from(toolCallApprovals)
    .where(
      and(
        eq(toolCallApprovals.sessionId, context.sessionId),
        eq(toolCallApprovals.requesterUserId, context.userId),
        eq(toolCallApprovals.status, 'pending'),
        gt(toolCallApprovals.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(toolCallApprovals.createdAt);
  return rows.map(metadata);
}

/** Executor-side read while polling for the requester's decision. */
export async function getToolCallApproval(
  approvalId: string,
  database: DatabaseOrTransaction = db,
): Promise<ToolCallApprovalRow | undefined> {
  return database.query.toolCallApprovals.findFirst({
    where: eq(toolCallApprovals.id, approvalId),
  });
}

/**
 * Requester-only decision. The conditional update is the whole authority
 * check: wrong approver, already-decided (duplicate response), and expired
 * rows all match zero rows and fail closed.
 */
export async function decideToolCallApproval(
  context: { sessionId: string; userId: string },
  input: { approvalId: string; decision: 'approved' | 'rejected' },
): Promise<ToolCallApprovalMetadata> {
  const [row] = await db
    .update(toolCallApprovals)
    .set({
      status: input.decision,
      decidedByUserId: context.userId,
      decidedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(toolCallApprovals.id, input.approvalId),
        eq(toolCallApprovals.sessionId, context.sessionId),
        eq(toolCallApprovals.requesterUserId, context.userId),
        eq(toolCallApprovals.status, 'pending'),
        gt(toolCallApprovals.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  if (!row) throw new ToolCallApprovalUnavailableError('approval_not_found');
  return metadata(row);
}

/**
 * One-shot consumption binding the execution to the exact approved call:
 * only an approved, unconsumed row with the same requester and argument
 * fingerprint transitions, so a changed-arguments call or a second execution
 * attempt matches zero rows and fails closed.
 */
export async function consumeToolCallApproval(input: {
  approvalId: string;
  requesterUserId: string;
  argsFingerprint: string;
}): Promise<boolean> {
  const [row] = await db
    .update(toolCallApprovals)
    .set({ status: 'consumed' })
    .where(
      and(
        eq(toolCallApprovals.id, input.approvalId),
        eq(toolCallApprovals.requesterUserId, input.requesterUserId),
        eq(toolCallApprovals.argsFingerprint, input.argsFingerprint),
        eq(toolCallApprovals.status, 'approved'),
      ),
    )
    .returning({ id: toolCallApprovals.id });
  return Boolean(row);
}

/** Lazily fail an unanswered window closed; safe to call on any pending row. */
export async function expireToolCallApproval(
  approvalId: string,
): Promise<void> {
  await db
    .update(toolCallApprovals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(toolCallApprovals.id, approvalId),
        eq(toolCallApprovals.status, 'pending'),
      ),
    );
}

export { metadata as toolCallApprovalMetadata };
export type { ToolCallApprovalRow };
