import { cloudJobs, db, eq, tasks } from '@roomote/db/server';

interface SetTaskHarnessSessionIdInput {
  cloudJobId: number;
  harnessSessionId: string;
}

export async function setTaskHarnessSessionId(
  input: SetTaskHarnessSessionIdInput,
): Promise<void> {
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, input.cloudJobId),
    columns: { taskId: true },
  });

  if (!cloudJob?.taskId) {
    return;
  }

  await db
    .update(tasks)
    .set({
      harnessSessionId: input.harnessSessionId,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, cloudJob.taskId));
}
