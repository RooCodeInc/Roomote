import type { TaskPayloadKind } from '@roomote/types';
import {
  db,
  desc,
  eq,
  isVisibleTask,
  inArray,
  taskRuns,
  tasks,
} from '@roomote/db/server';

/**
 * Common task select columns used by searchTasks and getTaskSummary.
 */
export const TASK_SELECT_COLUMNS = {
  id: tasks.id,
  title: tasks.title,
  mode: tasks.mode,
  state: tasks.state,
  harness: tasks.harness,
  timestamp: tasks.timestamp,
  activityAt: tasks.activityAt,
  repositoryName: tasks.repositoryName,
  goalObjective: tasks.goalObjective,
  goalStatus: tasks.goalStatus,
  goalMaxContinuations: tasks.goalMaxContinuations,
  goalContinuationsUsed: tasks.goalContinuationsUsed,
  goalBlockedReason: tasks.goalBlockedReason,
  goalStartedAt: tasks.goalStartedAt,
  goalEndedAt: tasks.goalEndedAt,
  goalCompletedAt: tasks.goalCompletedAt,
  goalLastContinuationId: tasks.goalLastContinuationId,
  goalGenerationIds: tasks.goalGenerationIds,
};

interface LatestTaskRunSummary {
  id: number;
  taskId: string | null;
  type: TaskPayloadKind;
  status: string;
  taskPhase: string | null;
  error: string | null;
  environmentSetupState: string | null;
  firstAssistantOutputAt: Date | null;
  payload: unknown;
}

export const visibleTaskHistoryCondition = isVisibleTask();

/**
 * Fetch the latest run row for each task ID.
 */
export async function getLatestTaskRunsByTaskIds(
  taskIds: string[],
): Promise<Record<string, LatestTaskRunSummary>> {
  if (taskIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      type: taskRuns.payloadKind,
      status: taskRuns.status,
      taskPhase: taskRuns.taskPhase,
      error: taskRuns.error,
      environmentSetupState: taskRuns.environmentSetupState,
      firstAssistantOutputAt: taskRuns.firstAssistantOutputAt,
      payload: taskRuns.payload,
    })
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(taskRuns.taskId, desc(taskRuns.id));

  const latestByTask = new Map<string, LatestTaskRunSummary>();

  for (const row of rows) {
    if (row.taskId && !latestByTask.has(row.taskId)) {
      latestByTask.set(row.taskId, row);
    }
  }

  return Object.fromEntries(latestByTask);
}

/**
 * Find the most recent run for a task.
 * Used by cancelTask and sendMessage.
 */
export function findLatestTaskRun<
  T extends Record<string, boolean> | undefined,
>(taskId: string, columns?: T) {
  return db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, taskId),
    orderBy: desc(taskRuns.createdAt),
    ...(columns && { columns }),
  });
}

/**
 * Channel bindings now live on the tasks row (moved off runs in the Stage 2
 * data-model simplification). Shared lookup for handlers that need Slack or
 * Linear thread routing for a task.
 */
export function getTaskChannelBindings(taskId: string) {
  return db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: {
      slackChannelId: true,
      slackThreadTs: true,
      linearSessionId: true,
      linearIssueId: true,
      linearOrganizationId: true,
    },
  });
}
