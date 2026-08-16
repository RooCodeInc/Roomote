import {
  db,
  tasks,
  taskRuns,
  taskPullRequests,
  environments,
  llmUsageEvents,
  and,
  eq,
  inArray,
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

const MULTIPLE_VALUES_LABEL = 'Multiple';

export function aggregateCostAnalyticsRowsByTask(
  rows: AnalyticsRow[],
): AnalyticsRow[] {
  const aggregatedRows = new Map<string, AnalyticsRow>();
  const ungroupedRows: AnalyticsRow[] = [];

  for (const row of rows) {
    const taskId = row.meta?.canonicalTaskId;
    if (!taskId) {
      ungroupedRows.push(row);
      continue;
    }

    const existingRow = aggregatedRows.get(taskId);
    if (!existingRow) {
      aggregatedRows.set(taskId, {
        ...row,
        id: `task:${taskId}`,
        details: {
          ...row.details,
          id: `task:${taskId}`,
        },
      });
      continue;
    }

    const value = existingRow.value + row.value;
    const values: Record<string, string> = {
      ...existingRow.details.values,
      cost: value.toFixed(2),
    };

    for (const [key, rowValue] of Object.entries(row.details.values)) {
      if (key === 'date' || key === 'cost' || key === 'taskTitle') {
        continue;
      }

      if (values[key] !== rowValue) {
        values[key] = MULTIPLE_VALUES_LABEL;
      }
    }

    aggregatedRows.set(taskId, {
      ...existingRow,
      value,
      details: {
        ...existingRow.details,
        values,
      },
    });
  }

  return [...aggregatedRows.values(), ...ungroupedRows].sort(
    (left, right) => right.timestamp.getTime() - left.timestamp.getTime(),
  );
}

export async function getCostAnalyticsRows(
  _auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<AnalyticsRow[]> {
  const cutoff = getTimeCutoff(timePeriod, now);
  const usageCutoffCondition = cutoff
    ? sql`coalesce(${llmUsageEvents.messageCompletedAt}, ${llmUsageEvents.createdAt}) >= ${sql.param(
        cutoff,
        llmUsageEvents.createdAt,
      )}`
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
      actorDisplayName: tasks.actorDisplayName,
      eventUserName: usageUsers.name,
      eventUserEmail: usageUsers.email,
      taskUserName: taskInitiatorUsers.name,
      taskUserEmail: taskInitiatorUsers.email,
      runEnvironmentId: sql<
        string | null
      >`${taskRuns.payload} ->> 'environmentId'`,
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

  const fallbackEnvironmentIds = [
    ...new Set(
      usageRows
        .filter((row) => !row.environmentName)
        .map((row) => row.runEnvironmentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const environmentRows =
    fallbackEnvironmentIds.length === 0
      ? []
      : await db
          .select({ id: environments.id, name: environments.name })
          .from(environments)
          .where(
            and(
              eq(environments.isEval, false),
              inArray(environments.id, fallbackEnvironmentIds),
            ),
          );
  const environmentNameById = new Map(
    environmentRows.map((environment) => [environment.id, environment.name]),
  );
  const pullRequestRows = await db
    .select({
      taskId: taskPullRequests.taskId,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      sourceControlProvider: taskPullRequests.sourceControlProvider,
      host: taskPullRequests.host,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .where(
      and(
        isNull(tasks.deletedAt),
        sql`exists (
          select 1
          from ${llmUsageEvents}
          where ${and(
            eq(llmUsageEvents.taskId, taskPullRequests.taskId),
            usageCutoffCondition,
          )}
        )`,
      ),
    );
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
          actorDisplayName: row.actorDisplayName,
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
    const project =
      row.environmentName ??
      (row.runEnvironmentId
        ? (environmentNameById.get(row.runEnvironmentId) ?? NO_PROJECT_LABEL)
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
