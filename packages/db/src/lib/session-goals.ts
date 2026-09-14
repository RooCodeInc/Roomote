import { randomUUID } from 'node:crypto';

import type {
  SessionGoal,
  SessionGoalStatus,
  SessionGoalInput,
} from '@roomote/types';
import { and, eq, or, sql } from 'drizzle-orm';

import { db } from '../db';
import { sessionGoals, sessions } from '../schema';
import { touchSessionActivity } from './sessions';

const GOAL_GENERATION_PREFIX = 'goal-generation:';

export type SessionGoalMutationResult =
  | { updated: true; goal: SessionGoal }
  | {
      updated: false;
      reason:
        | 'missing'
        | 'not_active'
        | 'budget_exhausted'
        | 'already_claimed'
        | 'blocker_pending'
        | 'generation_mismatch';
      goal: SessionGoal | null;
    };

function toSessionGoal(row: typeof sessionGoals.$inferSelect): SessionGoal {
  return {
    objective: row.objective,
    generation: row.lastContinuationId,
    status: row.status,
    maxContinuations: row.maxContinuations,
    continuationsUsed: row.continuationsUsed,
    blockedReason: row.blockedReason,
    completedAt: row.completedAt,
  };
}

async function getSessionIdForConversation(conversationId: string) {
  const row = await db.query.sessions.findFirst({
    where: eq(sessions.fastConversationId, conversationId),
    columns: { id: true },
  });
  return row?.id ?? null;
}

export async function getSessionGoal(
  sessionId: string,
): Promise<SessionGoal | null> {
  const row = await db.query.sessionGoals.findFirst({
    where: eq(sessionGoals.sessionId, sessionId),
  });
  return row ? toSessionGoal(row) : null;
}

export async function getSessionGoalForConversation(
  conversationId: string,
): Promise<SessionGoal | null> {
  const sessionId = await getSessionIdForConversation(conversationId);
  return sessionId ? getSessionGoal(sessionId) : null;
}

export async function replaceSessionGoal(input: {
  sessionId: string;
  userId: string;
  goal: SessionGoalInput;
}): Promise<{
  goal: SessionGoal;
  rollback: () => Promise<boolean>;
}> {
  const generation = `${GOAL_GENERATION_PREFIX}${randomUUID()}`;
  const previous = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1)
      .for('update');
    if (!session) throw new Error('Session not found.');

    const prior = await tx.query.sessionGoals.findFirst({
      where: eq(sessionGoals.sessionId, input.sessionId),
    });
    await tx
      .insert(sessionGoals)
      .values({
        sessionId: input.sessionId,
        objective: input.goal.objective,
        status: 'active',
        maxContinuations: input.goal.maxContinuations,
        continuationsUsed: 0,
        blockedReason: null,
        completedAt: null,
        lastContinuationId: generation,
        continuationIds: [],
        generationIds: [generation],
        blockerCandidateReason: null,
        blockerCandidateCount: 0,
        blockerLastContinuationUsed: null,
        startedAt: new Date(),
        endedAt: null,
        createdByUserId: input.userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sessionGoals.sessionId,
        set: {
          objective: input.goal.objective,
          status: 'active',
          maxContinuations: input.goal.maxContinuations,
          continuationsUsed: 0,
          blockedReason: null,
          completedAt: null,
          lastContinuationId: generation,
          continuationIds: [],
          generationIds: [generation],
          blockerCandidateReason: null,
          blockerCandidateCount: 0,
          blockerLastContinuationUsed: null,
          startedAt: new Date(),
          endedAt: null,
          createdByUserId: input.userId,
          updatedAt: new Date(),
        },
      });
    return prior ?? null;
  });
  await touchSessionActivity(
    db,
    input.sessionId,
    Math.floor(Date.now() / 1_000),
  );

  return {
    goal: {
      ...input.goal,
      generation,
      status: 'active',
      continuationsUsed: 0,
      blockedReason: null,
      completedAt: null,
    },
    rollback: async () => {
      const currentFilter = and(
        eq(sessionGoals.sessionId, input.sessionId),
        eq(sessionGoals.lastContinuationId, generation),
      );
      if (!previous) {
        const [removed] = await db
          .delete(sessionGoals)
          .where(currentFilter)
          .returning({ sessionId: sessionGoals.sessionId });
        if (removed) {
          await touchSessionActivity(
            db,
            input.sessionId,
            Math.floor(Date.now() / 1_000),
          );
        }
        return Boolean(removed);
      }
      const { sessionId: _sessionId, ...restored } = previous;
      const [row] = await db
        .update(sessionGoals)
        .set(restored)
        .where(currentFilter)
        .returning({ sessionId: sessionGoals.sessionId });
      if (row) {
        await touchSessionActivity(
          db,
          input.sessionId,
          Math.floor(Date.now() / 1_000),
        );
      }
      return Boolean(row);
    },
  };
}

function assignedGenerationFilter(generation: string) {
  return or(
    eq(sessionGoals.lastContinuationId, generation),
    sql`${generation} = ANY(${sessionGoals.generationIds})`,
  );
}

function hasAssignedGeneration(
  row: typeof sessionGoals.$inferSelect,
  generation: string,
) {
  return (
    row.lastContinuationId === generation ||
    row.generationIds.includes(generation)
  );
}

export async function markSessionGoal(input: {
  sessionId: string;
  generation: string;
  status: Extract<SessionGoalStatus, 'complete' | 'blocked' | 'canceled'>;
  reason?: string;
}): Promise<SessionGoalMutationResult> {
  const result: SessionGoalMutationResult = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessionGoals)
      .where(eq(sessionGoals.sessionId, input.sessionId))
      .limit(1)
      .for('update');
    if (!row) return { updated: false, reason: 'missing', goal: null };
    if (row.status !== 'active') {
      return { updated: false, reason: 'not_active', goal: toSessionGoal(row) };
    }
    if (!hasAssignedGeneration(row, input.generation)) {
      return {
        updated: false,
        reason: 'generation_mismatch',
        goal: toSessionGoal(row),
      };
    }

    if (input.status === 'blocked') {
      const reason = input.reason?.trim();
      if (!reason) throw new Error('A blocker reason is required.');
      const sameTurn =
        row.blockerLastContinuationUsed === row.continuationsUsed;
      const sameReason = row.blockerCandidateReason === reason;
      const candidateCount =
        sameTurn && sameReason
          ? row.blockerCandidateCount
          : sameReason
            ? row.blockerCandidateCount + 1
            : 1;
      const [updated] = await tx
        .update(sessionGoals)
        .set(
          candidateCount >= 3
            ? {
                status: 'blocked',
                blockedReason: reason,
                completedAt: new Date(),
                endedAt: new Date(),
                blockerCandidateReason: null,
                blockerCandidateCount: 0,
                blockerLastContinuationUsed: null,
                updatedAt: new Date(),
              }
            : {
                blockerCandidateReason: reason,
                blockerCandidateCount: candidateCount,
                blockerLastContinuationUsed: row.continuationsUsed,
                updatedAt: new Date(),
              },
        )
        .where(
          and(
            eq(sessionGoals.sessionId, input.sessionId),
            eq(sessionGoals.status, 'active'),
            assignedGenerationFilter(input.generation),
          ),
        )
        .returning();
      if (!updated) {
        return { updated: false, reason: 'not_active', goal: null };
      }
      return candidateCount >= 3
        ? { updated: true, goal: toSessionGoal(updated) }
        : {
            updated: false,
            reason: 'blocker_pending',
            goal: toSessionGoal(updated),
          };
    }

    const [updated] = await tx
      .update(sessionGoals)
      .set({
        status: input.status,
        blockedReason: null,
        completedAt: new Date(),
        endedAt: new Date(),
        blockerCandidateReason: null,
        blockerCandidateCount: 0,
        blockerLastContinuationUsed: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionGoals.sessionId, input.sessionId),
          eq(sessionGoals.status, 'active'),
          assignedGenerationFilter(input.generation),
        ),
      )
      .returning();
    return updated
      ? { updated: true, goal: toSessionGoal(updated) }
      : { updated: false, reason: 'not_active', goal: null };
  });
  await touchSessionActivity(
    db,
    input.sessionId,
    Math.floor(Date.now() / 1_000),
  );
  return result;
}

export async function markSessionGoalForConversation(input: {
  conversationId: string;
  generation: string;
  status: Extract<SessionGoalStatus, 'complete' | 'blocked' | 'canceled'>;
  reason?: string;
}): Promise<SessionGoalMutationResult> {
  const sessionId = await getSessionIdForConversation(input.conversationId);
  return sessionId
    ? markSessionGoal({ ...input, sessionId })
    : { updated: false, reason: 'missing', goal: null };
}

export async function claimSessionGoalContinuation(input: {
  conversationId: string;
  continuationId: string;
}): Promise<SessionGoalMutationResult> {
  const sessionId = await getSessionIdForConversation(input.conversationId);
  if (!sessionId) return { updated: false, reason: 'missing', goal: null };
  const current = await db.query.sessionGoals.findFirst({
    where: eq(sessionGoals.sessionId, sessionId),
  });
  if (!current) return { updated: false, reason: 'missing', goal: null };
  if (current.status !== 'active') {
    return {
      updated: false,
      reason: 'not_active',
      goal: toSessionGoal(current),
    };
  }
  if (current.continuationIds.includes(input.continuationId)) {
    return {
      updated: false,
      reason: 'already_claimed',
      goal: toSessionGoal(current),
    };
  }
  if (current.continuationsUsed >= current.maxContinuations) {
    const [limited] = await db
      .update(sessionGoals)
      .set({
        status: 'budget_limited',
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionGoals.sessionId, sessionId),
          eq(sessionGoals.status, 'active'),
          eq(sessionGoals.lastContinuationId, current.lastContinuationId),
        ),
      )
      .returning();
    await touchSessionActivity(db, sessionId, Math.floor(Date.now() / 1_000));
    return {
      updated: false,
      reason: 'budget_exhausted',
      goal: toSessionGoal(limited ?? current),
    };
  }

  const [updated] = await db
    .update(sessionGoals)
    .set({
      continuationsUsed: sql`${sessionGoals.continuationsUsed} + 1`,
      lastContinuationId: input.continuationId,
      continuationIds: sql`array_append(${sessionGoals.continuationIds}, ${input.continuationId})`,
      generationIds: sql`array_append(${sessionGoals.generationIds}, ${input.continuationId})`,
      blockerCandidateReason: sql`CASE WHEN ${sessionGoals.blockerLastContinuationUsed} = ${sessionGoals.continuationsUsed} THEN ${sessionGoals.blockerCandidateReason} ELSE NULL END`,
      blockerCandidateCount: sql`CASE WHEN ${sessionGoals.blockerLastContinuationUsed} = ${sessionGoals.continuationsUsed} THEN ${sessionGoals.blockerCandidateCount} ELSE 0 END`,
      blockerLastContinuationUsed: sql`CASE WHEN ${sessionGoals.blockerLastContinuationUsed} = ${sessionGoals.continuationsUsed} THEN ${sessionGoals.blockerLastContinuationUsed} ELSE NULL END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionGoals.sessionId, sessionId),
        eq(sessionGoals.status, 'active'),
        eq(sessionGoals.lastContinuationId, current.lastContinuationId),
        sql`${sessionGoals.continuationsUsed} < ${sessionGoals.maxContinuations}`,
        sql`NOT (${input.continuationId} = ANY(${sessionGoals.continuationIds}))`,
      ),
    )
    .returning();
  if (updated) {
    await touchSessionActivity(db, sessionId, Math.floor(Date.now() / 1_000));
  }
  return updated
    ? { updated: true, goal: toSessionGoal(updated) }
    : {
        updated: false,
        reason: 'generation_mismatch',
        goal: toSessionGoal(current),
      };
}

export async function releaseSessionGoalContinuation(input: {
  conversationId: string;
  continuationId: string;
}): Promise<boolean> {
  const sessionId = await getSessionIdForConversation(input.conversationId);
  if (!sessionId) return false;
  const [updated] = await db
    .update(sessionGoals)
    .set({
      continuationsUsed: sql`GREATEST(${sessionGoals.continuationsUsed} - 1, 0)`,
      continuationIds: sql`array_remove(${sessionGoals.continuationIds}, ${input.continuationId})`,
      generationIds: sql`array_remove(${sessionGoals.generationIds}, ${input.continuationId})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionGoals.sessionId, sessionId),
        eq(sessionGoals.status, 'active'),
        sql`${input.continuationId} = ANY(${sessionGoals.continuationIds})`,
      ),
    )
    .returning({ sessionId: sessionGoals.sessionId });
  return Boolean(updated);
}
