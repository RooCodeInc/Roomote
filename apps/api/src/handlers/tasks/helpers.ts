import type { CloudTaskType } from '@roomote/types';
import {
  cloudJobs,
  db,
  desc,
  eq,
  isVisibleTask,
  inArray,
  tasks,
} from '@roomote/db/server';

/**
 * Common task select columns used by searchTasks and getTaskSummary.
 */
export const TASK_SELECT_COLUMNS = {
  id: tasks.id,
  title: tasks.title,
  mode: tasks.mode,
  completed: tasks.completed,
  harness: tasks.harness,
  timestamp: tasks.timestamp,
  activityAt: tasks.activityAt,
  repositoryName: tasks.repositoryName,
};

interface LatestCloudJobSummary {
  id: number;
  taskId: string | null;
  type: CloudTaskType;
  status: string;
  taskPhase: string | null;
  error: string | null;
  firstAssistantOutputAt: Date | null;
  payload: unknown;
}

export const visibleTaskHistoryCondition = isVisibleTask(tasks.id);

/**
 * Fetch the latest cloud job row for each task ID.
 */
export async function getLatestCloudJobsByTaskIds(
  taskIds: string[],
): Promise<Record<string, LatestCloudJobSummary>> {
  if (taskIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({
      id: cloudJobs.id,
      taskId: cloudJobs.taskId,
      type: cloudJobs.type,
      status: cloudJobs.status,
      taskPhase: cloudJobs.taskPhase,
      error: cloudJobs.error,
      firstAssistantOutputAt: cloudJobs.firstAssistantOutputAt,
      payload: cloudJobs.payload,
    })
    .from(cloudJobs)
    .where(inArray(cloudJobs.taskId, taskIds))
    .orderBy(cloudJobs.taskId, desc(cloudJobs.id));

  const latestByTask = new Map<string, LatestCloudJobSummary>();

  for (const row of rows) {
    if (row.taskId && !latestByTask.has(row.taskId)) {
      latestByTask.set(row.taskId, row);
    }
  }

  return Object.fromEntries(latestByTask);
}

/**
 * Find the most recent cloud job for a task.
 * Used by cancelTask and sendMessage.
 */
export function findLatestCloudJob<
  T extends Record<string, boolean> | undefined,
>(taskId: string, columns?: T) {
  return db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.taskId, taskId),
    orderBy: desc(cloudJobs.createdAt),
    ...(columns && { columns }),
  });
}
