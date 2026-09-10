import { isDeepStrictEqual } from 'node:util';

import { and, asc, count, desc, eq, lte, sql } from 'drizzle-orm';

import {
  MAX_ACTIVE_SESSION_WAKEUPS,
  SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES,
  type SessionWakeupReportPolicy,
  type SessionWakeupSchedule,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { fastAgentConversations, sessionWakeups } from '../schema';
import type { SessionWakeup } from '../types';
import { runInTransactionIfAvailable } from './transaction-utils';

/**
 * Collapse whitespace and case so two prompts that read the same dedupe to
 * the same active wakeup.
 */
export function buildSessionWakeupPromptSignature(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function countActiveSessionWakeups(
  conversationId: string,
  tx: DatabaseOrTransaction = db,
): Promise<number> {
  return tx
    .select({ value: count() })
    .from(sessionWakeups)
    .where(
      and(
        eq(sessionWakeups.conversationId, conversationId),
        eq(sessionWakeups.status, 'active'),
      ),
    )
    .then((rows) => rows[0]?.value ?? 0);
}

export function listActiveSessionWakeups(
  conversationId: string,
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup[]> {
  return tx
    .select()
    .from(sessionWakeups)
    .where(
      and(
        eq(sessionWakeups.conversationId, conversationId),
        eq(sessionWakeups.status, 'active'),
      ),
    )
    .orderBy(asc(sessionWakeups.nextRunAt), asc(sessionWakeups.createdAt));
}

/** Active first, then the most recent terminal rows for history. */
export function listSessionWakeups(
  conversationId: string,
  options: { includeTerminal?: boolean; limit?: number } = {},
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup[]> {
  const limit = options.limit ?? 50;
  return tx
    .select()
    .from(sessionWakeups)
    .where(
      options.includeTerminal
        ? eq(sessionWakeups.conversationId, conversationId)
        : and(
            eq(sessionWakeups.conversationId, conversationId),
            eq(sessionWakeups.status, 'active'),
          ),
    )
    .orderBy(
      sql`case when ${sessionWakeups.status} = 'active' then 0 else 1 end`,
      asc(sessionWakeups.nextRunAt),
      desc(sessionWakeups.updatedAt),
    )
    .limit(limit);
}

export async function getSessionWakeupById(
  id: string,
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup | null> {
  const [row] = await tx
    .select()
    .from(sessionWakeups)
    .where(eq(sessionWakeups.id, id))
    .limit(1);
  return row ?? null;
}

export type InsertSessionWakeupInput = {
  conversationId: string;
  createdByUserId: string | null;
  name: string;
  prompt: string;
  schedule: SessionWakeupSchedule;
  reportPolicy: SessionWakeupReportPolicy;
  maxRuns: number | null;
  until: Date | null;
  nextRunAt: Date;
};

export type AdmitSessionWakeupResult =
  | { outcome: 'created' | 'duplicate'; wakeup: SessionWakeup }
  | { outcome: 'cap_reached' };

/** Serialize create admission even when tools run concurrently within a turn. */
export async function admitSessionWakeup(
  input: InsertSessionWakeupInput,
  database: DatabaseOrTransaction = db,
): Promise<AdmitSessionWakeupResult> {
  return runInTransactionIfAvailable(database, async (tx) => {
    const [conversation] = await tx
      .select({ id: fastAgentConversations.id })
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, input.conversationId))
      .for('update');
    if (!conversation) {
      throw new Error(`Conversation ${input.conversationId} does not exist.`);
    }

    const promptSignature = buildSessionWakeupPromptSignature(input.prompt);
    const active = await listActiveSessionWakeups(input.conversationId, tx);
    const existing = active.find(
      (row) =>
        row.promptSignature === promptSignature &&
        (row.schedule.mode === 'once' &&
        input.schedule.mode === 'once' &&
        row.schedule.inMinutes !== undefined &&
        input.schedule.inMinutes !== undefined
          ? row.schedule.inMinutes === input.schedule.inMinutes
          : isDeepStrictEqual(row.schedule, input.schedule)),
    );
    if (existing) return { outcome: 'duplicate', wakeup: existing };
    if (active.length >= MAX_ACTIVE_SESSION_WAKEUPS) {
      return { outcome: 'cap_reached' };
    }

    return { outcome: 'created', wakeup: await insertSessionWakeup(input, tx) };
  });
}

export async function insertSessionWakeup(
  input: InsertSessionWakeupInput,
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup> {
  const [row] = await tx
    .insert(sessionWakeups)
    .values({
      conversationId: input.conversationId,
      createdByUserId: input.createdByUserId,
      name: input.name,
      prompt: input.prompt,
      promptSignature: buildSessionWakeupPromptSignature(input.prompt),
      schedule: input.schedule,
      reportPolicy: input.reportPolicy,
      status: 'active',
      maxRuns: input.maxRuns,
      until: input.until,
      nextRunAt: input.nextRunAt,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert session wakeup.');
  }
  return row;
}

/**
 * Cancel one active wakeup in a conversation. Returns the row when it was
 * active and is now cancelled, and null when it was missing, belonged to
 * another conversation, or had already reached a terminal state.
 */
export async function cancelSessionWakeup(
  params: { id: string; conversationId: string },
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup | null> {
  const now = new Date();
  const [row] = await tx
    .update(sessionWakeups)
    .set({
      status: 'cancelled',
      nextRunAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionWakeups.id, params.id),
        eq(sessionWakeups.conversationId, params.conversationId),
        eq(sessionWakeups.status, 'active'),
      ),
    )
    .returning();
  return row ?? null;
}

/** Cancel every active wakeup in a conversation, e.g. when it is archived. */
export async function cancelSessionWakeupsForConversation(
  conversationId: string,
  tx: DatabaseOrTransaction = db,
): Promise<number> {
  const now = new Date();
  const rows = await tx
    .update(sessionWakeups)
    .set({
      status: 'cancelled',
      nextRunAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionWakeups.conversationId, conversationId),
        eq(sessionWakeups.status, 'active'),
      ),
    )
    .returning({ id: sessionWakeups.id });
  return rows.length;
}

export type ClaimSessionWakeupFireInput = {
  id: string;
  /** The occurrence the caller intends to fire; the claim fails if it moved. */
  expectedNextRunAt: Date;
  /** The occurrence after this one, or null when this is the last run. */
  nextRunAt: Date | null;
  firedAt: Date;
};

/**
 * Compare-and-set claim of one occurrence. Two workers holding the same
 * delayed job cannot both fire it, and a stale job that arrives after the
 * row already advanced is a no-op. The row completes when there is no next
 * occurrence.
 */
export async function claimSessionWakeupFire(
  input: ClaimSessionWakeupFireInput,
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup | null> {
  const [row] = await tx
    .update(sessionWakeups)
    .set({
      runCount: sql`${sessionWakeups.runCount} + 1`,
      lastFiredAt: input.firedAt,
      nextRunAt: input.nextRunAt,
      ...(input.nextRunAt
        ? {}
        : { status: 'completed' as const, completedAt: input.firedAt }),
      updatedAt: input.firedAt,
    })
    .where(
      and(
        eq(sessionWakeups.id, input.id),
        eq(sessionWakeups.status, 'active'),
        eq(sessionWakeups.nextRunAt, input.expectedNextRunAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Record how the turn a wakeup admitted ended. A success clears the failure
 * streak; enough consecutive failures retire a still-active wakeup.
 */
export async function recordSessionWakeupOutcome(
  params: { id: string; status: 'succeeded' | 'failed'; error?: string },
  tx: DatabaseOrTransaction = db,
): Promise<SessionWakeup | null> {
  const now = new Date();
  if (params.status === 'succeeded') {
    const [row] = await tx
      .update(sessionWakeups)
      .set({ consecutiveFailures: 0, lastError: null, updatedAt: now })
      .where(eq(sessionWakeups.id, params.id))
      .returning();
    return row ?? null;
  }

  const [row] = await tx
    .update(sessionWakeups)
    .set({
      consecutiveFailures: sql`${sessionWakeups.consecutiveFailures} + 1`,
      lastError: params.error ?? null,
      updatedAt: now,
    })
    .where(eq(sessionWakeups.id, params.id))
    .returning();
  if (!row) return null;
  if (
    row.status !== 'active' ||
    row.consecutiveFailures < SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES
  ) {
    return row;
  }

  const [retired] = await tx
    .update(sessionWakeups)
    .set({
      status: 'failed',
      nextRunAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionWakeups.id, params.id),
        eq(sessionWakeups.status, 'active'),
      ),
    )
    .returning();
  return retired ?? row;
}

/**
 * Active wakeups whose occurrence is due on or before `dueBy`. The recovery
 * sweep uses this to re-add lost delayed jobs; the claim keeps duplicates
 * harmless.
 */
export function listDueSessionWakeups(
  params: { dueBy: Date; limit?: number },
  tx: DatabaseOrTransaction = db,
): Promise<Pick<SessionWakeup, 'id' | 'nextRunAt'>[]> {
  return tx
    .select({ id: sessionWakeups.id, nextRunAt: sessionWakeups.nextRunAt })
    .from(sessionWakeups)
    .where(
      and(
        eq(sessionWakeups.status, 'active'),
        lte(sessionWakeups.nextRunAt, params.dueBy),
      ),
    )
    .orderBy(asc(sessionWakeups.nextRunAt))
    .limit(params.limit ?? 500);
}
