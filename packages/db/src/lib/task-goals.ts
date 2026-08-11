import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { TaskGoal, TaskGoalInput, TaskGoalStatus } from '@roomote/types';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { db } from '../db';
import { taskRuns, tasks } from '../schema';

const GOAL_ACTIVATION_WAIT_MS = 35_000;
const GOAL_ACTIVATION_POLL_MS = 50;
const GOAL_ACTIVATION_PREFIX = 'goal-activation:';
const GOAL_GENERATION_PREFIX = 'goal-generation:';

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

function hasPendingGoalActivation(task: typeof tasks.$inferSelect): boolean {
  return (
    task.goalStatus === 'active' &&
    Boolean(task.goalLastContinuationId?.startsWith(GOAL_ACTIVATION_PREFIX))
  );
}

/**
 * Restricts a goal mutation to the exact goal generation the caller read.
 *
 * `goalLastContinuationId` advances on every activation and every claim, so an
 * in-flight completion that read the previous goal cannot mutate a replacement
 * goal that was activated after that read.
 */
function goalGenerationFilter(generation: string | null) {
  return generation === null
    ? isNull(tasks.goalLastContinuationId)
    : eq(tasks.goalLastContinuationId, generation);
}

async function waitForGoalActivation(
  runId: number,
  activationId: string,
): Promise<typeof tasks.$inferSelect | undefined> {
  const deadline = Date.now() + GOAL_ACTIVATION_WAIT_MS;
  let task = await getTaskForRun(runId);

  while (
    task?.goalLastContinuationId === activationId &&
    hasPendingGoalActivation(task) &&
    Date.now() < deadline
  ) {
    await delay(GOAL_ACTIVATION_POLL_MS);
    task = await getTaskForRun(runId);
  }

  return task;
}

export async function getTaskGoalForRun(
  runId: number,
): Promise<TaskGoal | null> {
  const task = await getTaskForRun(runId);
  return task ? toTaskGoal(task) : null;
}

export async function prepareTaskGoalActivation(input: {
  taskId: string;
  goal: TaskGoalInput;
}): Promise<{
  commit: () => Promise<TaskGoal | null>;
  rollback: () => Promise<boolean>;
} | null> {
  const activationUuid = randomUUID();
  const activationId = `${GOAL_ACTIVATION_PREFIX}${activationUuid}`;
  const generationId = `${GOAL_GENERATION_PREFIX}${activationUuid}`;
  const previous = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .for('update');
    if (!task || hasPendingGoalActivation(task)) {
      return null;
    }

    const [prepared] = await tx
      .update(tasks)
      .set({
        goalObjective: input.goal.objective,
        goalStatus: 'active',
        goalMaxContinuations: input.goal.maxContinuations,
        goalContinuationsUsed: 0,
        goalBlockedReason: null,
        goalCompletedAt: null,
        goalLastContinuationId: activationId,
        goalContinuationIds: [],
        goalBlockerCandidateReason: null,
        goalBlockerCandidateCount: 0,
        goalBlockerLastContinuationUsed: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, input.taskId))
      .returning({ id: tasks.id });

    return prepared ? task : null;
  });

  if (!previous) {
    return null;
  }

  const pendingFilter = and(
    eq(tasks.id, input.taskId),
    eq(tasks.goalStatus, 'active'),
    eq(tasks.goalLastContinuationId, activationId),
  );

  return {
    commit: async () => {
      const [updated] = await db
        .update(tasks)
        .set({
          goalLastContinuationId: generationId,
          updatedAt: new Date(),
        })
        .where(pendingFilter)
        .returning();

      return updated ? toTaskGoal(updated) : null;
    },
    rollback: async () => {
      const [restored] = await db
        .update(tasks)
        .set({
          goalObjective: previous.goalObjective,
          goalStatus: previous.goalStatus,
          goalMaxContinuations: previous.goalMaxContinuations,
          goalContinuationsUsed: previous.goalContinuationsUsed,
          goalBlockedReason: previous.goalBlockedReason,
          goalCompletedAt: previous.goalCompletedAt,
          goalLastContinuationId: previous.goalLastContinuationId,
          goalContinuationIds: previous.goalContinuationIds,
          goalBlockerCandidateReason: previous.goalBlockerCandidateReason,
          goalBlockerCandidateCount: previous.goalBlockerCandidateCount,
          goalBlockerLastContinuationUsed:
            previous.goalBlockerLastContinuationUsed,
          updatedAt: new Date(),
        })
        .where(pendingFilter)
        .returning({ id: tasks.id });

      return Boolean(restored);
    },
  };
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
  let task = await getTaskForRun(runId);
  if (!task) {
    return { updated: false, reason: 'missing', goal: null };
  }
  if (hasPendingGoalActivation(task)) {
    const activationId = task.goalLastContinuationId!;
    task = await waitForGoalActivation(runId, activationId);
    if (!task) {
      return { updated: false, reason: 'missing', goal: null };
    }
    if (hasPendingGoalActivation(task)) {
      return { updated: false, reason: 'not_active', goal: null };
    }
  }
  const existingGoal = toTaskGoal(task);
  if (task.goalStatus !== 'active' || !existingGoal) {
    return { updated: false, reason: 'not_active', goal: existingGoal };
  }
  if (task.goalContinuationIds.includes(continuationId)) {
    return {
      updated: false,
      reason: 'already_claimed',
      goal: toTaskGoal(task),
    };
  }

  const claimedGeneration = task.goalLastContinuationId;
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
        goalGenerationFilter(claimedGeneration),
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
  if (!current || current.goalLastContinuationId !== claimedGeneration) {
    // The goal advanced or was replaced after this completion read it, so this
    // turn must settle normally instead of consuming another goal's budget.
    return { updated: false, reason: 'not_active', goal };
  }
  const budgetExhausted = goal?.status === 'active';
  if (goal?.status === 'active') {
    const [limited] = await db
      .update(tasks)
      .set({ goalStatus: 'budget_limited', updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, current.id),
          eq(tasks.goalStatus, 'active'),
          goalGenerationFilter(claimedGeneration),
        ),
      )
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
      goalLastContinuationId: `${GOAL_GENERATION_PREFIX}${randomUUID()}`,
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
