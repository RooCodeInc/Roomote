import type { CloudTaskStatus } from '@roomote/types';
import { db, cloudJobs, eq } from '@roomote/db/server';

type UpdateCloudJobRuntimeState = {
  taskPhase: string | null;
  sleepAt: Date | null;
};

function shouldApplyRuntimeStateUpdate(
  current: {
    taskPhase: string | null;
    sleepAt: Date | null;
    status: CloudTaskStatus;
  },
  next: UpdateCloudJobRuntimeState,
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

export async function updateCloudJobRuntimeState(
  cloudJobId: number,
  values: UpdateCloudJobRuntimeState,
): Promise<{ updated: boolean }> {
  try {
    const current = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, cloudJobId),
      columns: { status: true, taskPhase: true, sleepAt: true },
    });

    if (!current) {
      return { updated: false };
    }

    if (!shouldApplyRuntimeStateUpdate(current, values)) {
      return { updated: false };
    }

    await db
      .update(cloudJobs)
      .set({ taskPhase: values.taskPhase, sleepAt: values.sleepAt })
      .where(eq(cloudJobs.id, cloudJobId));

    return { updated: true };
  } catch (error) {
    console.error(
      `[updateCloudJobRuntimeState] Failed to update cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return { updated: false };
  }
}
