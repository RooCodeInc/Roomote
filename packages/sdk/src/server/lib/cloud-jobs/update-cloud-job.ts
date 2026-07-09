import { type UpdateCloudJob, db, taskRuns, eq } from '@roomote/db/server';

export async function updateCloudJob(
  cloudJobId: number,
  values: UpdateCloudJob,
): Promise<void> {
  try {
    await db.update(taskRuns).set(values).where(eq(taskRuns.id, cloudJobId));
  } catch (error) {
    console.error(
      `[updateCloudJob] Failed to update cloud job ${cloudJobId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
