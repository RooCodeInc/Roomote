import { db, taskRuns, eq } from '@roomote/db/server';

export async function touchCloudJobHeartbeat(
  cloudJobId: number,
  heartbeatAt: Date = new Date(),
): Promise<void> {
  await db
    .update(taskRuns)
    .set({ workerHeartbeatAt: heartbeatAt })
    .where(eq(taskRuns.id, cloudJobId));
}
