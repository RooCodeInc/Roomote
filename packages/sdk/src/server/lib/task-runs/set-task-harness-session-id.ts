import { db, eq, taskRuns, tasks } from '@roomote/db/server';

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

  await db
    .update(tasks)
    .set({
      harnessSessionId: input.harnessSessionId,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskRun.taskId));
}
