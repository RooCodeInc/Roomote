import { RunStatus, type TaskPhase, WORKING_TASK_PHASES } from '@roomote/types';
import {
  clearTaskResolution,
  db,
  eq,
  openTaskResolutionOnCloseout,
  taskRuns,
} from '@roomote/db/server';

type UpdateTaskRunRuntimeState = {
  taskPhase: string | null;
  sleepAt: Date | null;
};

function shouldApplyRuntimeStateUpdate(
  current: {
    taskPhase: string | null;
    sleepAt: Date | null;
    status: RunStatus;
  },
  next: UpdateTaskRunRuntimeState,
): boolean {
  if (next.taskPhase === 'shutting_down' || next.sleepAt == null) {
    return true;
  }

  if (current.taskPhase !== next.taskPhase) {
    return true;
  }

  if (current.sleepAt == null) {
    return true;
  }

  return next.sleepAt.getTime() >= current.sleepAt.getTime();
}

export async function updateTaskRunRuntimeState(
  runId: number,
  values: UpdateTaskRunRuntimeState,
): Promise<{ updated: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      const current = await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, runId),
        columns: { taskId: true, status: true, taskPhase: true, sleepAt: true },
      });

      if (!current) {
        return { updated: false };
      }

      if (!shouldApplyRuntimeStateUpdate(current, values)) {
        return { updated: false };
      }

      await tx
        .update(taskRuns)
        .set({ taskPhase: values.taskPhase, sleepAt: values.sleepAt })
        .where(eq(taskRuns.id, runId));

      const enteredWaitingForPrompt =
        WORKING_TASK_PHASES.has(current.taskPhase as TaskPhase) &&
        values.taskPhase === 'waiting_for_prompt';
      if (
        enteredWaitingForPrompt &&
        current.status !== RunStatus.Failed &&
        current.status !== RunStatus.Canceled
      ) {
        await openTaskResolutionOnCloseout(current.taskId, { executor: tx });
      } else if (
        current.taskPhase !== values.taskPhase &&
        WORKING_TASK_PHASES.has(values.taskPhase as TaskPhase)
      ) {
        await clearTaskResolution(current.taskId, { executor: tx });
      }

      return { updated: true };
    });
  } catch (error) {
    console.error(
      `[updateTaskRunRuntimeState] Failed to update task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return { updated: false };
  }
}
