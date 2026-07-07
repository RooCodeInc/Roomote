import {
  cloudJobs,
  db,
  desc,
  eq,
  resolveTaskAttributionDisplay,
  sql,
  taskInferenceUsageEvents,
  tasks,
  users,
} from '@roomote/db/server';

import type {
  TaskInferenceUsageSummary,
  TaskWithAssociations,
  UserAuthSuccess,
} from '@/types';
import {
  applyTaskPullRequestFallbackToCloudJob,
  getArtifactsForTask,
  getLatestTaskPullRequestsByTaskId,
} from '@/lib/server';

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
        .select({ task: tasks, user: users, cloudJob: cloudJobs })
        .from(tasks)
        .leftJoin(users, eq(tasks.attributedUserId, users.id))
        .leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
        .where(eq(tasks.id, taskId))
        .orderBy(desc(cloudJobs.createdAt))
        .limit(1),
      getLatestTaskPullRequestsByTaskId([taskId]),
      getTaskInferenceUsageByTaskId(taskId),
    ]);

  if (!result) {
    return null;
  }

  const { task, user, cloudJob } = result;
  const displayUserId =
    task.effectiveAuthorKind === 'roomote'
      ? null
      : (task.effectiveAuthorUserId ?? task.attributedUserId);
  const displayUser =
    displayUserId && displayUserId !== user?.id
      ? await db.query.users.findFirst({
          where: eq(users.id, displayUserId),
        })
      : (user ?? null);
  const cloudJobWithFallback = applyTaskPullRequestFallbackToCloudJob(
    cloudJob,
    taskPullRequestsByTaskId[taskId],
  );
  const attribution = resolveTaskAttributionDisplay(
    {
      attributionKind: task.attributionKind,
      attributedUserId: task.attributedUserId,
      attributionSourceKind: task.attributionSourceKind,
      attributionSourceDisplayName: task.attributionSourceDisplayName,
      attributionSourceExternalId: task.attributionSourceExternalId,
      attributedGithubLogin: task.attributedGithubLogin,
      effectiveAuthorKind: task.effectiveAuthorKind,
      effectiveAuthorUserId: task.effectiveAuthorUserId,
      effectiveAuthorDisplayName: task.effectiveAuthorDisplayName,
      effectiveAuthorGithubLogin: task.effectiveAuthorGithubLogin,
      effectiveAuthorGithubUserId: task.effectiveAuthorGithubUserId,
      effectiveAuthorReason: task.effectiveAuthorReason,
      effectiveAuthorRuleId: task.effectiveAuthorRuleId,
      effectivePrOwnerKind: task.effectivePrOwnerKind,
      effectivePrOwnerUserId: task.effectivePrOwnerUserId,
      effectivePrOwnerDisplayName: task.effectivePrOwnerDisplayName,
      effectivePrOwnerGithubLogin: task.effectivePrOwnerGithubLogin,
      effectivePrOwnerReason: task.effectivePrOwnerReason,
      effectivePrOwnerRuleId: task.effectivePrOwnerRuleId,
    },
    {
      attributedUser: user,
    },
  );

  const taskData: TaskWithAssociations = {
    ...task,
    user: displayUser ?? null,
    attributionLabel: attribution.productDisplay,
    attributionKind: attribution.kind,
    cloudJob: cloudJobWithFallback,
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
