import {
  db,
  desc,
  eq,
  isNull,
  and,
  sql,
  taskInferenceUsageEvents,
  taskRuns,
  tasks,
  users,
} from '@roomote/db/server';

import type {
  TaskInferenceUsageSummary,
  TaskWithAssociations,
  UserAuthSuccess,
} from '@/types';
import {
  getArtifactsForTask,
  getLatestTaskPullRequestsByTaskId,
} from '@/lib/server';
import { resolveTaskCreatorDisplay } from '@/lib/server/tasks';

export type TaskByIdAccessResult =
  | {
      kind: 'not-found';
    }
  | {
      kind: 'resolved';
      task: TaskWithAssociations;
    };

const EMPTY_INFERENCE_USAGE: TaskInferenceUsageSummary = {
  eventCount: 0,
  costMicroUsd: 0,
};

function normalizeInferenceUsageSummary(
  usage: TaskInferenceUsageSummary | undefined,
): TaskInferenceUsageSummary {
  return {
    eventCount: Number(usage?.eventCount ?? 0),
    costMicroUsd: Number(usage?.costMicroUsd ?? 0),
  };
}

async function getTaskInferenceUsageByTaskId(
  taskId: string,
): Promise<TaskInferenceUsageSummary> {
  const [usage] = await db
    .select({
      eventCount: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${taskInferenceUsageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(taskInferenceUsageEvents)
    .where(eq(taskInferenceUsageEvents.taskId, taskId));

  return normalizeInferenceUsageSummary(usage ?? EMPTY_INFERENCE_USAGE);
}

async function getTaskByIdForCurrentOrg(
  auth: Pick<UserAuthSuccess, 'userId' | 'isAdmin'>,
  {
    taskId,
    includeArtifacts = false,
  }: { taskId: string; includeArtifacts?: boolean },
): Promise<TaskWithAssociations | null> {
  const [[result], taskPullRequestsByTaskId, inferenceUsage] =
    await Promise.all([
      db
        .select({ task: tasks, user: users, taskRun: taskRuns })
        .from(tasks)
        .leftJoin(users, eq(tasks.initiatorUserId, users.id))
        .leftJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
        .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
        .orderBy(desc(taskRuns.id))
        .limit(1),
      getLatestTaskPullRequestsByTaskId([taskId]),
      getTaskInferenceUsageByTaskId(taskId),
    ]);

  if (!result) {
    return null;
  }

  const { task, user, taskRun } = result;
  const creator = resolveTaskCreatorDisplay(task, user);
  const latestPullRequest = taskPullRequestsByTaskId[taskId];

  const taskData: TaskWithAssociations = {
    ...task,
    user: user ?? null,
    attributionLabel: creator.label,
    attributionKind: creator.kind,
    taskRun: taskRun
      ? {
          ...taskRun,
          prRepo: latestPullRequest?.repository ?? null,
          prNumber: latestPullRequest?.prNumber ?? null,
        }
      : null,
    inferenceUsage,
  };

  if (includeArtifacts) {
    const artifacts = await getArtifactsForTask({
      taskId: task.id,
      auth: { userId: auth.userId, isAdmin: auth.isAdmin },
    });

    taskData.artifacts = artifacts;
  }

  return taskData;
}

export async function resolveTaskByIdAccessCommand(
  auth: Pick<UserAuthSuccess, 'userId' | 'isAdmin'>,
  {
    taskId,
    includeArtifacts = false,
  }: { taskId: string; includeArtifacts?: boolean },
): Promise<TaskByIdAccessResult> {
  const task = await getTaskByIdForCurrentOrg(auth, {
    taskId,
    includeArtifacts,
  });

  if (task) {
    return {
      kind: 'resolved',
      task,
    };
  }

  return { kind: 'not-found' };
}

export async function getTaskByIdCommand(
  auth: UserAuthSuccess,
  {
    taskId,
    includeArtifacts = false,
  }: { taskId: string; includeArtifacts?: boolean },
): Promise<TaskWithAssociations | null> {
  const taskAccess = await resolveTaskByIdAccessCommand(auth, {
    taskId,
    includeArtifacts,
  });

  if (taskAccess.kind !== 'resolved') {
    return null;
  }

  return taskAccess.task;
}
