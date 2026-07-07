import { db, cloudJobs, eq } from '@roomote/db/server';

export async function touchCloudJobHeartbeat(
  cloudJobId: number,
  heartbeatAt: Date = new Date(),
): Promise<void> {
  await db
    .update(cloudJobs)
    .set({ workerHeartbeatAt: heartbeatAt })
    .where(eq(cloudJobs.id, cloudJobId));
}
