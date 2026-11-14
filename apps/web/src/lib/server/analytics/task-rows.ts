import { type TaskSurface } from '@roomote/types';
import {
  db,
  tasks,
  users,
  environments,
  llmUsageEvents,
  taskRuns,
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  sql,
} from '@roomote/db/server';

import { type AnalyticsMetric, type TimePeriodFilter } from '@/types';
import type { UserAuthSuccess } from '@/types';

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
import {
  formatAnalyticsDateTime,
  formatPrivateAnalyticsDate,
  getTimeCutoff,
} from './time-buckets';
import {
  canViewPrivateAnalyticsDetails,
  createPrivateAnalyticsIdMapper,
  PRIVATE_TASK_LABEL,
  privateAnalyticsDimensionValue,
} from './privacy';

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

  const getPrivateId = createPrivateAnalyticsIdMapper('private-task');

  return taskRows.map((task) => {
    const sourceLabel = mapTaskSource(task.surface);
    const usage = usageByTaskId[task.id];
    const value = getTaskMetricValue(metric, usage);
    if (!task.canViewDetails) {
      const id = getPrivateId(task.id);
      const values: Record<string, string> = {
        date: formatPrivateAnalyticsDate(task.timestamp),
        user: PRIVATE_TASK_LABEL,
        project: PRIVATE_TASK_LABEL,
        source: PRIVATE_TASK_LABEL,
        taskType: PRIVATE_TASK_LABEL,
        taskTitle: PRIVATE_TASK_LABEL,
      };

      if (metric === 'tokens') {
        values.tokens = formatTaskMetricDetailValue(metric, usage);
      } else if (metric === 'cost') {
        values.cost = formatTaskMetricDetailValue(metric, usage);
      }

      return {
        id,
        timestamp: task.timestamp,
        value,
        dimensions: {
          user: task.userDimension,
          project: privateAnalyticsDimensionValue,
          source: privateAnalyticsDimensionValue,
          taskType: createLabelBackedDimensionValue(PRIVATE_TASK_LABEL),
        },
        details: {
          id,
          values: { ...values, user: task.userDimension.label },
        },
      } satisfies AnalyticsRow;
    }

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
  canViewDetails: boolean;
};

const LATEST_RUN_LOOKUP_BATCH_SIZE = 5_000;

/**
 * Only the latest run's environment is needed here. Loading whole run rows
 * (payload JSON for every run of every task) took hundreds of MB per request
 * on large deployments and exhausted the web heap.
 */
async function getLatestRunEnvironmentIdsByTaskId(
  taskIds: string[],
): Promise<Map<string, string>> {
  const environmentIdByTaskId = new Map<string, string>();
  for (
    let index = 0;
    index < taskIds.length;
    index += LATEST_RUN_LOOKUP_BATCH_SIZE
  ) {
    const batch = taskIds.slice(index, index + LATEST_RUN_LOOKUP_BATCH_SIZE);
    const rows = await db
      .selectDistinctOn([taskRuns.taskId], {
        taskId: taskRuns.taskId,
        environmentId: sql<
          string | null
        >`${taskRuns.payload} ->> 'environmentId'`,
      })
      .from(taskRuns)
      .where(inArray(taskRuns.taskId, batch))
      .orderBy(taskRuns.taskId, desc(taskRuns.id));
    for (const row of rows) {
      if (row.taskId && row.environmentId) {
        environmentIdByTaskId.set(row.taskId, row.environmentId);
      }
    }
  }
  return environmentIdByTaskId;
}

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
      privacy: tasks.privacy,
      privateOwnerUserId: tasks.privateOwnerUserId,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.initiatorUserId))
    .where(
      and(
        isNull(tasks.deletedAt),
        cutoff ? gte(tasks.createdAt, cutoff) : undefined,
      ),
    )
    .orderBy(desc(tasks.timestamp));

  const filteredTasks = taskResults;

  const detailTaskIds = filteredTasks
    .filter((task) => canViewPrivateAnalyticsDetails(auth, task))
    .map((task) => task.id);
  const environmentIdByTaskId =
    await getLatestRunEnvironmentIdsByTaskId(detailTaskIds);

  const environmentIds = [...new Set(environmentIdByTaskId.values())];

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
    const canViewDetails = canViewPrivateAnalyticsDetails(auth, task);
    const environmentId = environmentIdByTaskId.get(task.id) ?? null;

    const userDimension =
      task.initiatorKind === 'automation'
        ? createLabelBackedDimensionValue(NO_VALUE_LABEL)
        : getTaskInitiatorDimensionValue(task);

    return {
      id: task.id,
      title: task.title,
      timestamp: task.timestamp,
      surface: task.surface,
      projectLabel: canViewDetails
        ? getProjectLabel(task.repositoryName, environmentId)
        : PRIVATE_TASK_LABEL,
      userDimension,
      taskTypeDimension: getTaskTypeDimensionValue(task),
      canViewDetails,
    } satisfies TaskAnalyticsBaseRow;
  });
}
