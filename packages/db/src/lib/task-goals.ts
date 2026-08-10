import type { TaskGoal, TaskGoalStatus } from '@roomote/types';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { db } from '../db';
import { taskRuns, tasks } from '../schema';

export type TaskGoalMutationResult =
  | { updated: true; goal: TaskGoal }
  | {
      updated: false;
      reason:
        | 'missing'
        | 'not_active'
        | 'budget_exhausted'
        | 'already_claimed'
        | 'blocker_pending';
      goal: TaskGoal | null;
    };

function toTaskGoal(task: typeof tasks.$inferSelect): TaskGoal | null {
  if (
    !task.goalObjective ||
    !task.goalStatus ||
    task.goalMaxContinuations === null
  ) {
    return null;
  }

  return {
    objective: task.goalObjective,
    status: task.goalStatus,
    maxContinuations: task.goalMaxContinuations,
    continuationsUsed: task.goalContinuationsUsed,
    blockedReason: task.goalBlockedReason,
    completedAt: task.goalCompletedAt,
  };
}

async function getTaskForRun(runId: number) {
  const [row] = await db
    .select({ task: tasks })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(eq(taskRuns.id, runId))
    .limit(1);

  return row?.task;
}

export async function getTaskGoalForRun(
  runId: number,
): Promise<TaskGoal | null> {
  const task = await getTaskForRun(runId);
  return task ? toTaskGoal(task) : null;
}

export async function markTaskGoalForRun(
  input: {
    runId: number;
  } & (
    | { status: Extract<TaskGoalStatus, 'complete'> }
    | {
        status: Extract<TaskGoalStatus, 'blocked'>;
        reason: string;
      }
  ),
): Promise<TaskGoalMutationResult> {
  if (input.status === 'blocked') {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ task: tasks })
        .from(taskRuns)
        .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
        .where(eq(taskRuns.id, input.runId))
        .limit(1)
        .for('update');
      const task = row?.task;
      if (!task) {
        return { updated: false, reason: 'missing', goal: null };
      }
      if (task.goalStatus !== 'active') {
        return {
          updated: false,
          reason: 'not_active',
          goal: toTaskGoal(task),
        };
      }

      const reason = input.reason.trim();
      const sameTurn =
        task.goalBlockerLastContinuationUsed === task.goalContinuationsUsed;
      const sameReason = task.goalBlockerCandidateReason === reason;
      const candidateCount =
        sameTurn && sameReason
          ? task.goalBlockerCandidateCount
          : sameReason
            ? task.goalBlockerCandidateCount + 1
            : 1;

      const [updated] = await tx
        .update(tasks)
        .set(
          candidateCount >= 3
            ? {
                goalStatus: 'blocked',
                goalBlockedReason: reason,
                goalBlockerCandidateReason: null,
                goalBlockerCandidateCount: 0,
                goalBlockerLastContinuationUsed: null,
                updatedAt: new Date(),
              }
            : {
                goalBlockerCandidateReason: reason,
                goalBlockerCandidateCount: candidateCount,
                goalBlockerLastContinuationUsed: task.goalContinuationsUsed,
                updatedAt: new Date(),
              },
        )
        .where(and(eq(tasks.id, task.id), eq(tasks.goalStatus, 'active')))
        .returning();

      if (!updated) {
        const current = await getTaskForRun(input.runId);
        return {
          updated: false,
          reason: 'not_active',
          goal: current ? toTaskGoal(current) : null,
        };
      }

      return candidateCount >= 3
        ? { updated: true, goal: toTaskGoal(updated)! }
        : {
            updated: false,
            reason: 'blocker_pending',
            goal: toTaskGoal(updated),
          };
    });
  }

  const task = await getTaskForRun(input.runId);
  if (!task) {
    return { updated: false, reason: 'missing', goal: null };
  }

  const [updated] = await db
    .update(tasks)
    .set({
      goalStatus: input.status,
      goalBlockedReason: null,
      goalCompletedAt: new Date(),
      goalBlockerCandidateReason: null,
      goalBlockerCandidateCount: 0,
      goalBlockerLastContinuationUsed: null,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.goalStatus, 'active')))
    .returning();

  if (updated) {
    return { updated: true, goal: toTaskGoal(updated)! };
  }

  const current = await getTaskForRun(input.runId);
  return {
    updated: false,
    reason: 'not_active',
    goal: current ? toTaskGoal(current) : null,
  };
}

export async function claimTaskGoalContinuationForRun(input: {
  runId: number;
  continuationId: string;
}): Promise<TaskGoalMutationResult> {
  const { runId, continuationId } = input;
  const task = await getTaskForRun(runId);
  if (!task) {
    return { updated: false, reason: 'missing', goal: null };
  }
  if (
    task.goalStatus === 'active' &&
    task.goalContinuationIds.includes(continuationId)
  ) {
    return {
      updated: false,
      reason: 'already_claimed',
      goal: toTaskGoal(task),
    };
  }

  const [updated] = await db
    .update(tasks)
    .set({
      goalContinuationsUsed: sql`${tasks.goalContinuationsUsed} + 1`,
      goalLastContinuationId: continuationId,
      goalContinuationIds: sql`array_append(${tasks.goalContinuationIds}, ${continuationId})`,
      goalBlockerCandidateReason: sql`CASE WHEN ${tasks.goalBlockerLastContinuationUsed} = ${tasks.goalContinuationsUsed} THEN ${tasks.goalBlockerCandidateReason} ELSE NULL END`,
      goalBlockerCandidateCount: sql`CASE WHEN ${tasks.goalBlockerLastContinuationUsed} = ${tasks.goalContinuationsUsed} THEN ${tasks.goalBlockerCandidateCount} ELSE 0 END`,
      goalBlockerLastContinuationUsed: sql`CASE WHEN ${tasks.goalBlockerLastContinuationUsed} = ${tasks.goalContinuationsUsed} THEN ${tasks.goalBlockerLastContinuationUsed} ELSE NULL END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.goalStatus, 'active'),
        isNotNull(tasks.goalObjective),
        isNotNull(tasks.goalMaxContinuations),
        lt(tasks.goalContinuationsUsed, tasks.goalMaxContinuations),
        sql`NOT (${continuationId} = ANY(${tasks.goalContinuationIds}))`,
      ),
    )
    .returning();

  if (updated) {
    return { updated: true, goal: toTaskGoal(updated)! };
  }

  const current = await getTaskForRun(runId);
  let goal = current ? toTaskGoal(current) : null;
  if (current?.goalContinuationIds.includes(continuationId)) {
    return {
      updated: false,
      reason: 'already_claimed',
      goal,
    };
  }
  const budgetExhausted = goal?.status === 'active';
  if (goal?.status === 'active') {
    const [limited] = await db
      .update(tasks)
      .set({ goalStatus: 'budget_limited', updatedAt: new Date() })
      .where(and(eq(tasks.id, current!.id), eq(tasks.goalStatus, 'active')))
      .returning();
    goal = limited ? toTaskGoal(limited) : goal;
  }
  return {
    updated: false,
    reason: budgetExhausted ? 'budget_exhausted' : 'not_active',
    goal,
  };
}

export async function releaseTaskGoalContinuationForRun(input: {
  runId: number;
  continuationId: string;
}): Promise<boolean> {
  const task = await getTaskForRun(input.runId);
  if (!task) {
    return false;
  }

  const [released] = await db
    .update(tasks)
    .set({
      goalStatus: 'active',
      goalContinuationsUsed: sql`GREATEST(${tasks.goalContinuationsUsed} - 1, 0)`,
      goalLastContinuationId: null,
      goalContinuationIds: sql`array_remove(${tasks.goalContinuationIds}, ${input.continuationId})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, task.id),
        inArray(tasks.goalStatus, ['active', 'budget_limited']),
        sql`${input.continuationId} = ANY(${tasks.goalContinuationIds})`,
      ),
    )
    .returning({ id: tasks.id });

  return Boolean(released);
}
