import { type TaskSurface } from '@roomote/types';
import {
  db,
  tasks,
  users,
  environments,
  llmUsageEvents,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from '@roomote/db/server';

import { type AnalyticsMetric, type TimePeriodFilter } from '@/types';
import type { UserAuthSuccess } from '@/types';

import { getLatestTaskRunsByTaskId } from '../task-runs';
import {
  NO_PROJECT_LABEL,
  NO_VALUE_LABEL,
  type AnalyticsDimensionValue,
  type AnalyticsRow,
} from './types';
import {
  buildProjectNameByRepoMap,
  createLabelBackedDimensionValue,
  formatRepositoryLabel,
  getTaskInitiatorDimensionValue,
  getTaskTypeDimensionValue,
  mapTaskSource,
} from './dimensions';
import { formatAnalyticsDateTime, getTimeCutoff } from './time-buckets';

type TaskInferenceUsageTotals = {
  totalTokens: number;
  costUsd: number;
};

async function getTaskInferenceUsageTotalsByTaskIds(
  taskIds: string[],
): Promise<Record<string, TaskInferenceUsageTotals>> {
  if (taskIds.length === 0) {
    return {};
  }

  const results = await db
    .select({
      taskId: llmUsageEvents.taskId,
      totalTokens: sql<number>`coalesce(sum(${llmUsageEvents.totalTokens}), 0)::bigint`,
      costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(llmUsageEvents)
    .where(inArray(llmUsageEvents.taskId, taskIds))
    .groupBy(llmUsageEvents.taskId);

  const usageByTaskId: Record<string, TaskInferenceUsageTotals> = {};

  for (const row of results) {
    if (!row.taskId) {
      continue;
    }

    usageByTaskId[row.taskId] = {
      totalTokens: Number(row.totalTokens ?? 0),
      costUsd: Number(row.costMicroUsd ?? 0) / 1_000_000,
    };
  }

  return usageByTaskId;
}

function getTaskMetricValue(
  metric: AnalyticsMetric,
  usage: TaskInferenceUsageTotals | undefined,
): number {
  switch (metric) {
    case 'tokens':
      return usage?.totalTokens ?? 0;
    case 'cost':
      return usage?.costUsd ?? 0;
    case 'tasks':
    default:
      return 1;
  }
}

function formatTaskMetricDetailValue(
  metric: AnalyticsMetric,
  usage: TaskInferenceUsageTotals | undefined,
): string {
  switch (metric) {
    case 'tokens':
      return String(usage?.totalTokens ?? 0);
    case 'cost':
      return (usage?.costUsd ?? 0).toFixed(2);
    case 'tasks':
    default:
      return '1';
  }
}

export async function getTaskAnalyticsRows(
  auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
  metric: AnalyticsMetric,
): Promise<AnalyticsRow[]> {
  const taskRows = await getTaskAnalyticsBaseRows(auth, timePeriod, now);
  const usageByTaskId =
    metric === 'tasks'
      ? {}
      : await getTaskInferenceUsageTotalsByTaskIds(
          taskRows.map((task) => task.id),
        );

  return taskRows.map((task) => {
    const sourceLabel = mapTaskSource(task.surface);
    const usage = usageByTaskId[task.id];
    const value = getTaskMetricValue(metric, usage);
    const values: Record<string, string> = {
      date: formatAnalyticsDateTime(task.timestamp),
      user: task.userDimension.label,
      project: task.projectLabel,
      source: sourceLabel,
      taskType: task.taskTypeDimension.label,
      taskTitle: task.title,
      task: 'View task',
    };

    if (metric === 'tokens') {
      values.tokens = formatTaskMetricDetailValue(metric, usage);
    } else if (metric === 'cost') {
      values.cost = formatTaskMetricDetailValue(metric, usage);
    }

    return {
      id: task.id,
      timestamp: task.timestamp,
      value,
      dimensions: {
        user: task.userDimension,
        project: createLabelBackedDimensionValue(task.projectLabel),
        source: createLabelBackedDimensionValue(sourceLabel),
        taskType: task.taskTypeDimension,
      },
      details: {
        id: task.id,
        values,
        links: {
          task: `/task/${task.id}`,
        },
      },
    } satisfies AnalyticsRow;
  });
}

type TaskAnalyticsBaseRow = {
  id: string;
  title: string;
  timestamp: Date;
  surface: TaskSurface;
  projectLabel: string;
  userDimension: AnalyticsDimensionValue;
  taskTypeDimension: AnalyticsDimensionValue;
};

async function getTaskAnalyticsBaseRows(
  auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<TaskAnalyticsBaseRow[]> {
  const cutoff = getTimeCutoff(timePeriod, now);

  // Single-table read: creator, source, and repo are all columns on tasks.
  const taskResults = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      timestamp: tasks.createdAt,
      repositoryName: tasks.repositoryName,
      surface: tasks.surface,
      initiatorKind: tasks.initiatorKind,
      initiatorUserId: tasks.initiatorUserId,
      initiatorAutomation: tasks.initiatorAutomation,
      actorExternalId: tasks.actorExternalId,
      actorDisplayName: tasks.actorDisplayName,
      userName: users.name,
      userEmail: users.email,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.initiatorUserId))
    .where(isNull(tasks.deletedAt))
    .orderBy(desc(tasks.timestamp));

  const filteredTasks = cutoff
    ? taskResults.filter((task) => task.timestamp >= cutoff)
    : taskResults;

  const latestRunsByTaskId = await getLatestTaskRunsByTaskId(
    filteredTasks.map((task) => task.id),
  );

  const environmentIds = [
    ...new Set(
      filteredTasks
        .map((task) => {
          const payload = latestRunsByTaskId[task.id]?.payload;
          if (
            payload &&
            typeof payload === 'object' &&
            'environmentId' in payload &&
            typeof payload.environmentId === 'string'
          ) {
            return payload.environmentId;
          }
          return null;
        })
        .filter((value): value is string => value !== null),
    ),
  ];

  const environmentRows = await db
    .select({
      id: environments.id,
      name: environments.name,
      config: environments.config,
    })
    .from(environments)
    .where(eq(environments.isEval, false));

  const environmentNameMap = new Map<string, string>(
    environmentRows
      .filter((environment) => environmentIds.includes(environment.id))
      .map((environment) => [environment.id, environment.name]),
  );

  const projectNameByRepoMap = buildProjectNameByRepoMap(environmentRows);

  function getProjectLabel(
    repositoryName: string | null,
    environmentId: string | null,
  ) {
    if (environmentId) {
      const environmentName = environmentNameMap.get(environmentId);

      if (environmentName) {
        return environmentName;
      }
    }

    if (repositoryName) {
      return (
        projectNameByRepoMap.get(repositoryName.toLowerCase()) ||
        formatRepositoryLabel(repositoryName)
      );
    }

    return NO_PROJECT_LABEL;
  }

  return filteredTasks.map((task) => {
    const latestRun = latestRunsByTaskId[task.id];
    const payload = latestRun?.payload;
    const environmentId =
      payload &&
      typeof payload === 'object' &&
      'environmentId' in payload &&
      typeof payload.environmentId === 'string'
        ? payload.environmentId
        : null;

    const userDimension =
      task.initiatorKind === 'automation'
        ? createLabelBackedDimensionValue(NO_VALUE_LABEL)
        : getTaskInitiatorDimensionValue(task);

    return {
      id: task.id,
      title: task.title,
      timestamp: task.timestamp,
      surface: task.surface,
      projectLabel: getProjectLabel(task.repositoryName, environmentId),
      userDimension,
      taskTypeDimension: getTaskTypeDimensionValue(task),
    } satisfies TaskAnalyticsBaseRow;
  });
}
