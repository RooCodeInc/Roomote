import type { RunStatus } from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

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
    const current = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: { status: true, taskPhase: true, sleepAt: true },
    });

    if (!current) {
      return { updated: false };
    }

    if (!shouldApplyRuntimeStateUpdate(current, values)) {
      return { updated: false };
    }

    await db
      .update(taskRuns)
      .set({ taskPhase: values.taskPhase, sleepAt: values.sleepAt })
      .where(eq(taskRuns.id, runId));

    return { updated: true };
  } catch (error) {
    console.error(
      `[updateTaskRunRuntimeState] Failed to update task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return { updated: false };
  }
}
