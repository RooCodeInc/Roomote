import {
  activeRunStatuses,
  type TaskGoal,
  RunStatus,
  isExitedRunStatus,
} from '@roomote/types';
import { captureTaskSettled } from '@roomote/telemetry/server';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  markTaskStartParallelCountEndedAt,
  prepareTaskGoalActivation,
  taskRuns,
} from '@roomote/db/server';
import { settleSlackLiveTaskCardForRun } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';
import { sendSandboxPromptCommand } from '../sandbox-session';
import { resolveTaskByIdAccessCommand } from '../tasks/by-id';

export async function startTaskGoalCommand(
  auth: UserAuthSuccess,
  input: {
    taskId: string;
    goal: { objective: string; maxContinuations: number };
    clientMessageId?: string;
    userImageUrl?: string;
  },
): Promise<
  { success: true; goal: TaskGoal } | { success: false; error: string }
> {
  const taskAccess = await resolveTaskByIdAccessCommand(auth, {
    taskId: input.taskId,
  });

  if (taskAccess.kind !== 'resolved') {
    return { success: false, error: 'Task not found' };
  }

  const activation = await prepareTaskGoalActivation({
    taskId: input.taskId,
    goal: input.goal,
  });
  if (!activation) {
    return { success: false, error: 'Goal Mode activation is already pending' };
  }

  try {
    await sendSandboxPromptCommand(
      auth,
      {
        taskId: input.taskId,
        prompt: input.goal.objective,
        source: 'web',
        clientMessageId: input.clientMessageId,
        userImageUrl: input.userImageUrl,
        autoSteerWhenQueued: true,
      },
      {
        goalContext: {
          ...input.goal,
          generation: activation.generation,
          status: 'active',
          continuationsUsed: 0,
          blockedReason: null,
          completedAt: null,
        },
      },
    );
  } catch (error) {
    try {
      await activation.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back Goal Mode activation:', rollbackError);
    }
    throw error;
  }

  const goal = await activation.commit();
  if (!goal) {
    await activation.rollback();
    return { success: false, error: 'Goal Mode activation was superseded' };
  }

  return { success: true, goal };
}

export async function cancelTaskRunCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; runId?: number },
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const taskFilter = eq(taskRuns.taskId, input.taskId);

    const job =
      // Snapshot resumes reuse taskId, so a stale runId can still point at
      // an older non-terminal row. Always prefer the newest active run for the
      // task over the supplied ID.
      (await db.query.taskRuns.findFirst({
        where: and(
          taskFilter,
          inArray(taskRuns.status, [...activeRunStatuses]),
        ),
        orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      })) ??
      (input.runId !== undefined
        ? await db.query.taskRuns.findFirst({
            where: and(eq(taskRuns.id, input.runId), taskFilter),
            orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
          })
        : null) ??
      (await db.query.taskRuns.findFirst({
        where: taskFilter,
        orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      }));

    if (!job) {
      return { success: false, error: 'Task run not found' };
    }

    if (!isExitedRunStatus(job.status)) {
      const endedAt = new Date();

      const canceledRun = await db.transaction(async (tx) => {
        const [canceled] = await tx
          .update(taskRuns)
          .set({ status: RunStatus.Canceled, canceledAt: endedAt })
          .where(
            and(
              eq(taskRuns.id, job.id),
              inArray(taskRuns.status, [...activeRunStatuses]),
            ),
          )
          .returning({ id: taskRuns.id });

        if (!canceled) {
          return null;
        }

        await markTaskStartParallelCountEndedAt(tx, {
          runId: job.id,
          endedAt,
        });

        return canceled;
      });

      if (canceledRun) {
        void captureTaskSettled(canceledRun.id, 'canceled');
        // A run canceled before any worker claimed it has nobody else to
        // settle its Slack task card.
        void settleSlackLiveTaskCardForRun({
          taskId: job.taskId,
          payload: job.payload,
          status: RunStatus.Canceled,
        });
      }
    }

    return { success: true };
  } catch (error) {
    console.error(error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

export { retryFailedTaskStartCommand } from './retry-failed-start';
