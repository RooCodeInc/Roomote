import { activeRunStatuses } from '@roomote/types';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  taskRuns,
  tasks,
} from '@roomote/db/server';

interface SetTaskHarnessSessionIdInput {
  runId: number;
  harnessSessionId: string;
}

export async function setTaskHarnessSessionId(
  input: SetTaskHarnessSessionIdInput,
): Promise<void> {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { taskId: true },
  });

  if (!taskRun?.taskId) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({ harnessSessionId: input.harnessSessionId })
      .where(eq(taskRuns.id, input.runId));

    const currentRun = await tx.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.taskId, taskRun.taskId),
        inArray(taskRuns.status, [...activeRunStatuses]),
      ),
      orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      columns: { id: true, taskId: true },
    });

    // N-1 compatibility mirror for application versions that still read the
    // session from the task row. A late callback from a fenced source run must
    // never overwrite the successor's mirror.
    if (
      currentRun?.id === input.runId &&
      currentRun.taskId === taskRun.taskId
    ) {
      await tx
        .update(tasks)
        .set({
          harnessSessionId: input.harnessSessionId,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskRun.taskId));
    }
  });
}
