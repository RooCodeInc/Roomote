import {
  db,
  tasks,
  taskRuns,
  taskPullRequests,
  environments,
  llmUsageEvents,
  and,
  eq,
  isNull,
  sql,
} from '@roomote/db/server';

import { type TimePeriodFilter } from '@/types';
import type { UserAuthSuccess } from '@/types';

import {
  NO_PROJECT_LABEL,
  NO_VALUE_LABEL,
  taskInitiatorUsers,
  usageUsers,
  type AnalyticsRow,
} from './types';
import {
  createLabelBackedDimensionValue,
  getCanonicalUserDimensionValue,
  getPullRequestKey,
  getTaskTypeDimensionValue,
} from './dimensions';
import { formatAnalyticsDateTime, getTimeCutoff } from './time-buckets';

export async function getCostAnalyticsRows(
  _auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<AnalyticsRow[]> {
  const cutoff = getTimeCutoff(timePeriod, now);
  const usageCutoffCondition = cutoff
    ? sql`coalesce(${llmUsageEvents.messageCompletedAt}, ${llmUsageEvents.createdAt}) >= ${cutoff}`
    : undefined;
  const usageRows = await db
    .select({
      id: llmUsageEvents.id,
      timestamp: llmUsageEvents.messageCompletedAt,
      createdAt: llmUsageEvents.createdAt,
      costMicroUsd: llmUsageEvents.costMicroUsd,
      taskId: llmUsageEvents.taskId,
      runId: llmUsageEvents.runId,
      userId: llmUsageEvents.userId,
      taskUserId: tasks.initiatorUserId,
      providerId: llmUsageEvents.providerId,
      modelId: llmUsageEvents.modelId,
      environmentName: environments.name,
      taskTitle: tasks.title,
      initiatorKind: tasks.initiatorKind,
      initiatorAutomation: tasks.initiatorAutomation,
      eventUserName: usageUsers.name,
      eventUserEmail: usageUsers.email,
      taskUserName: taskInitiatorUsers.name,
      taskUserEmail: taskInitiatorUsers.email,
      runPayload: taskRuns.payload,
    })
    .from(llmUsageEvents)
    .leftJoin(tasks, eq(tasks.id, llmUsageEvents.taskId))
    .leftJoin(usageUsers, eq(usageUsers.id, llmUsageEvents.userId))
    .leftJoin(
      taskInitiatorUsers,
      eq(taskInitiatorUsers.id, tasks.initiatorUserId),
    )
    .leftJoin(taskRuns, eq(taskRuns.id, llmUsageEvents.runId))
    .leftJoin(environments, eq(environments.id, llmUsageEvents.environmentId))
    .where(and(isNull(tasks.deletedAt), usageCutoffCondition));

  const environmentRows = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(eq(environments.isEval, false));
  const environmentNameById = new Map(
    environmentRows.map((environment) => [environment.id, environment.name]),
  );
  // Fetch PR attribution with a relational join instead of expanding one bind
  // parameter per usage event. A task can have many usage rows, so an inArray
  // built from usageRows eventually exceeds PostgreSQL's parameter limit.
  const pullRequestRows = await db
    .selectDistinct({
      taskId: taskPullRequests.taskId,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      sourceControlProvider: taskPullRequests.sourceControlProvider,
      host: taskPullRequests.host,
    })
    .from(taskPullRequests)
    .innerJoin(
      llmUsageEvents,
      eq(llmUsageEvents.taskId, taskPullRequests.taskId),
    )
    .leftJoin(tasks, eq(tasks.id, llmUsageEvents.taskId))
    .where(and(isNull(tasks.deletedAt), usageCutoffCondition));
  const prKeysByTaskId = new Map<string, Set<string>>();
  for (const pullRequest of pullRequestRows) {
    if (pullRequest.prNumber === null || !pullRequest.repository) {
      continue;
    }

    const keys = prKeysByTaskId.get(pullRequest.taskId) ?? new Set<string>();
    keys.add(
      getPullRequestKey(
        pullRequest.repository,
        pullRequest.prNumber,
        pullRequest.sourceControlProvider,
        pullRequest.host ?? undefined,
      ),
    );
    prKeysByTaskId.set(pullRequest.taskId, keys);
  }

  return usageRows.map((row) => {
    const isTask = Boolean(row.taskId);
    const taskType = isTask
      ? getTaskTypeDimensionValue({
          initiatorKind: row.initiatorKind,
          initiatorAutomation: row.initiatorAutomation,
        })
      : createLabelBackedDimensionValue('Non-task inference');
    const attributedUserId = row.userId ?? row.taskUserId;
    const userDimension =
      isTask && row.initiatorKind === 'automation'
        ? createLabelBackedDimensionValue(NO_VALUE_LABEL)
        : attributedUserId
          ? getCanonicalUserDimensionValue({
              id: attributedUserId,
              name: row.userId ? row.eventUserName : row.taskUserName,
              email: row.userId ? row.eventUserEmail : row.taskUserEmail,
            })
          : createLabelBackedDimensionValue(NO_VALUE_LABEL);
    const timestamp = row.timestamp ?? row.createdAt;
    const cost = Number(row.costMicroUsd ?? 0) / 1_000_000;
    const provider = row.providerId ?? 'Unknown provider';
    const model = row.modelId ?? 'Unknown model';
    const runEnvironmentId =
      row.runPayload &&
      typeof row.runPayload === 'object' &&
      'environmentId' in row.runPayload &&
      typeof row.runPayload.environmentId === 'string'
        ? row.runPayload.environmentId
        : null;
    const project =
      row.environmentName ??
      (runEnvironmentId
        ? (environmentNameById.get(runEnvironmentId) ?? NO_PROJECT_LABEL)
        : NO_PROJECT_LABEL);

    return {
      id: row.id,
      timestamp,
      value: cost,
      dimensions: {
        user: userDimension,
        taskType,
        project: createLabelBackedDimensionValue(project),
        provider: createLabelBackedDimensionValue(provider),
        model: createLabelBackedDimensionValue(model),
      },
      details: {
        id: row.id,
        values: {
          date: formatAnalyticsDateTime(timestamp),
          user: userDimension.label,
          taskType: taskType.label,
          project,
          provider,
          model,
          cost: cost.toFixed(2),
          taskTitle: row.taskTitle ?? 'Non-task inference',
        },
        links: row.taskId ? { task: `/task/${row.taskId}` } : undefined,
      },
      meta: {
        canonicalTaskId: row.taskId,
        prKeys: row.taskId ? [...(prKeysByTaskId.get(row.taskId) ?? [])] : [],
      },
    } satisfies AnalyticsRow;
  });
}
