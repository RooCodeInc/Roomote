import {
  type CloudTaskType,
  isCloudTaskType,
  isHiddenCloudTaskType,
} from '@roomote/types';
import {
  type SQL,
  db,
  tasks,
  cloudJobs,
  taskPullRequests,
  taskInferenceUsageEvents,
  eq,
  and,
  desc,
  inArray,
  lt,
  isNull,
  or,
  resolveTaskAttributionDisplay,
  sql,
  isVisibleTask,
} from '@roomote/db/server';

import {
  type Task as SimpleTask,
  type TaskInferenceUsageSummary,
  type Filter,
  type TimePeriodFilter,
  HAS_PULL_REQUEST_FILTER_VALUE,
} from '@/types';
import { getTaskCategoryById } from '@/lib';
import { parseCreatorFilterValue } from '@/lib/task-creator-filter';

import { type SimpleUser, getUsersById } from './users';
import { type SimpleCloudJob, getLatestCloudJobsByTaskId } from './cloud-jobs';
import { getTaskModelDisplayNameMap } from './task-models';

/**
 * Task Filter Conditions
 */

type TaskFilterCondition = SQL<unknown>;

function getVisibleTaskHistoryCondition(): SQL<unknown> {
  // `isVisibleTask` constructs a DB-backed subquery, so keep it out of module
  // scope until apps/web has explicitly initialized the database singleton.
  return isVisibleTask(tasks.id);
}

function requiresCloudJobJoin(filters: Filter[]): boolean {
  return filters.some((filter) =>
    ['category', 'environmentId', 'taskType'].includes(filter.type),
  );
}

function getEffectiveFilters(
  filters: Filter[],
  { allowTaskTypeFilter }: { allowTaskTypeFilter: boolean },
): Filter[] {
  if (allowTaskTypeFilter) {
    return filters;
  }

  return filters.filter((filter) => filter.type !== 'taskType');
}

function getSelectedTaskTypes(filters: Filter[]): CloudTaskType[] {
  return [
    ...new Set(
      filters
        .filter((filter) => filter.type === 'taskType')
        .map((filter) => filter.value)
        .filter(isCloudTaskType),
    ),
  ];
}

const getTaskFilterConditions = async ({ filters }: { filters: Filter[] }) => {
  const conditions: TaskFilterCondition[] = [];
  const hasTaskTypeFilter = filters.some(
    (filter) => filter.type === 'taskType',
  );
  const selectedTaskTypes = getSelectedTaskTypes(filters);

  if (hasTaskTypeFilter) {
    if (selectedTaskTypes.length === 0) {
      conditions.push(sql`1 = 0`);
    } else {
      conditions.push(inArray(cloudJobs.type, selectedTaskTypes));
    }
  }

  for (const filter of filters) {
    switch (filter.type) {
      case 'userId': {
        const creatorFilter = parseCreatorFilterValue(filter.value);

        if (creatorFilter.kind === 'roomote') {
          conditions.push(
            or(
              eq(tasks.effectiveAuthorKind, 'roomote'),
              and(
                isNull(tasks.effectiveAuthorKind),
                eq(tasks.attributionKind, 'automatic'),
              ),
            )!,
          );
        } else if (creatorFilter.kind === 'unlinked_user') {
          conditions.push(
            and(
              eq(tasks.attributionKind, 'unlinked_user'),
              or(
                isNull(tasks.effectiveAuthorKind),
                and(
                  eq(tasks.effectiveAuthorKind, 'human'),
                  isNull(tasks.effectiveAuthorUserId),
                ),
              ),
              eq(tasks.attributionSourceKind, creatorFilter.sourceKind),
              eq(
                tasks.attributionSourceExternalId,
                creatorFilter.sourceExternalId,
              ),
            )!,
          );
        } else {
          conditions.push(
            or(
              and(
                eq(tasks.effectiveAuthorKind, 'human'),
                eq(tasks.effectiveAuthorUserId, creatorFilter.userId),
              ),
              and(
                isNull(tasks.effectiveAuthorKind),
                eq(tasks.attributedUserId, creatorFilter.userId),
              ),
            )!,
          );
        }

        break;
      }
      case 'category': {
        const taskCategory = getTaskCategoryById(filter.value);

        if (taskCategory) {
          conditions.push(inArray(cloudJobs.type, [...taskCategory.taskTypes]));
        }

        break;
      }
      case 'environmentId':
        conditions.push(
          sql`${cloudJobs.payload}->>'environmentId' = ${filter.value}`,
        );

        break;
      case 'repositoryName':
        conditions.push(eq(tasks.repositoryName, filter.value));
        break;
      case 'pullRequest':
        if (filter.value === HAS_PULL_REQUEST_FILTER_VALUE) {
          conditions.push(
            sql`EXISTS (
              SELECT 1
              FROM ${taskPullRequests}
              WHERE ${taskPullRequests.taskId} = ${tasks.id}
                AND ${taskPullRequests.repository} IS NOT NULL
                AND ${taskPullRequests.prNumber} IS NOT NULL
            )`,
          );
          break;
        }

        // Expected format: "owner/repo#123"
        {
          const [repoPart, numberPart] = filter.value.split('#');
          const prNumber = Number.parseInt(numberPart ?? '', 10);

          if (repoPart && Number.isFinite(prNumber) && prNumber > 0) {
            conditions.push(
              sql`EXISTS (
                SELECT 1
                FROM ${taskPullRequests}
                WHERE ${taskPullRequests.taskId} = ${tasks.id}
                  AND ${taskPullRequests.repository} = ${repoPart}
                  AND ${taskPullRequests.prNumber} = ${prNumber}
              )`,
            );
          }
        }

        break;
      case 'model':
        conditions.push(eq(tasks.model, filter.value));
        break;
      case 'taskType':
        break;
    }
  }

  return conditions;
};

function parseTaskActivityCursor(
  cursor?: string | number,
): { activityAt: number; id?: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  if (typeof cursor === 'number') {
    return Number.isFinite(cursor)
      ? { activityAt: Math.trunc(cursor) }
      : undefined;
  }

  const [rawActivityAt, rawId] = cursor.split(':', 2);
  const parsedActivityAt = Number(rawActivityAt);

  if (!Number.isFinite(parsedActivityAt)) {
    return undefined;
  }

  return {
    activityAt: Math.trunc(parsedActivityAt),
    id: rawId || undefined,
  };
}

/**
 * Get Tasks
 */

export type Task = SimpleTask & {
  attributionLabel: string;
  attributionKind: string | null;
  modelDisplayName?: string | null;
  user: SimpleUser | null;
  cloudJob: SimpleCloudJob;
  inferenceUsage?: TaskInferenceUsageSummary;
};

type GetTasksResult = {
  tasks: Task[];
  hasMore: boolean;
  nextCursor?: string;
};

/**
 * Aggregates inference usage (event count + cost in micro-USD) for a batch of
 * task IDs. Tasks with no usage events are omitted from the returned map.
 */
async function getTaskInferenceUsageByTaskIds(
  taskIds: string[],
): Promise<Record<string, TaskInferenceUsageSummary>> {
  if (taskIds.length === 0) {
    return {};
  }

  const results = await db
    .select({
      taskId: taskInferenceUsageEvents.taskId,
      eventCount: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${taskInferenceUsageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(taskInferenceUsageEvents)
    .where(inArray(taskInferenceUsageEvents.taskId, taskIds))
    .groupBy(taskInferenceUsageEvents.taskId);

  const usageByTaskId: Record<string, TaskInferenceUsageSummary> = {};

  for (const row of results) {
    usageByTaskId[row.taskId] = {
      eventCount: Number(row.eventCount ?? 0),
      costMicroUsd: Number(row.costMicroUsd ?? 0),
    };
  }

  return usageByTaskId;
}

export const getTasks = async ({
  limit = 30,
  cursor,
  filters = [],
  timePeriod = 'all',
  allowTaskTypeFilter = false,
}: {
  userId: string;
  isAdmin?: boolean;
  limit?: number;
  cursor?: string | number;
  filters?: Filter[];
  timePeriod?: TimePeriodFilter;
  allowTaskTypeFilter?: boolean;
}): Promise<GetTasksResult> => {
  const effectiveFilters = getEffectiveFilters(filters, {
    allowTaskTypeFilter,
  });
  const hasTaskTypeFilter = effectiveFilters.some(
    (filter) => filter.type === 'taskType',
  );
  const conditions = [];

  if (!hasTaskTypeFilter) {
    conditions.push(getVisibleTaskHistoryCondition());
  }

  conditions.push(
    ...(await getTaskFilterConditions({ filters: effectiveFilters })),
  );

  if (timePeriod !== 'all') {
    const cutoffTimestamp =
      Math.floor(Date.now() / 1000) - timePeriod * 24 * 60 * 60;

    conditions.push(sql`${tasks.activityAt} >= ${cutoffTimestamp}`);
  }

  const parsedCursor = parseTaskActivityCursor(cursor);

  if (parsedCursor) {
    if (parsedCursor.id) {
      conditions.push(
        sql`(${tasks.activityAt} < ${parsedCursor.activityAt} OR (${tasks.activityAt} = ${parsedCursor.activityAt} AND ${tasks.id} < ${parsedCursor.id}))`,
      );
    } else {
      conditions.push(lt(tasks.activityAt, parsedCursor.activityAt));
    }
  }

  const baseQuery = db
    .selectDistinct({
      id: tasks.id,
      harnessSessionId: tasks.harnessSessionId,
      userId: tasks.userId,
      attributedUserId: tasks.attributedUserId,
      attributionKind: tasks.attributionKind,
      attributionSourceKind: tasks.attributionSourceKind,
      attributionSourceDisplayName: tasks.attributionSourceDisplayName,
      attributionSourceExternalId: tasks.attributionSourceExternalId,
      attributedGithubLogin: tasks.attributedGithubLogin,
      effectiveAuthorKind: tasks.effectiveAuthorKind,
      effectiveAuthorUserId: tasks.effectiveAuthorUserId,
      effectiveAuthorDisplayName: tasks.effectiveAuthorDisplayName,
      effectiveAuthorGithubLogin: tasks.effectiveAuthorGithubLogin,
      effectiveAuthorGithubUserId: tasks.effectiveAuthorGithubUserId,
      effectiveAuthorReason: tasks.effectiveAuthorReason,
      effectiveAuthorRuleId: tasks.effectiveAuthorRuleId,
      effectivePrOwnerKind: tasks.effectivePrOwnerKind,
      effectivePrOwnerUserId: tasks.effectivePrOwnerUserId,
      effectivePrOwnerDisplayName: tasks.effectivePrOwnerDisplayName,
      effectivePrOwnerGithubLogin: tasks.effectivePrOwnerGithubLogin,
      effectivePrOwnerReason: tasks.effectivePrOwnerReason,
      effectivePrOwnerRuleId: tasks.effectivePrOwnerRuleId,
      title: tasks.title,
      model: tasks.model,
      mode: tasks.mode,
      completed: tasks.completed,
      timestamp: tasks.timestamp,
      activityAt: tasks.activityAt,
      repositoryUrl: tasks.repositoryUrl,
      repositoryName: tasks.repositoryName,
      defaultBranch: tasks.defaultBranch,
    })
    .from(tasks);

  const taskResults = await (
    requiresCloudJobJoin(effectiveFilters)
      ? baseQuery.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : baseQuery
  )
    .where(and(...conditions))
    .orderBy(desc(tasks.activityAt), desc(tasks.id))
    .limit(limit + 1); // Request one extra to determine hasMore.

  // Fetch associations (users, cloud jobs, cloud agents) in parallel.
  const userIds = [
    ...new Set([
      ...taskResults
        .map((t) =>
          t.effectiveAuthorKind === 'roomote'
            ? null
            : (t.effectiveAuthorUserId ?? t.attributedUserId),
        )
        .filter((id): id is string => id !== null),
    ]),
  ].filter((id): id is string => id !== null);

  const taskIds = taskResults.map((t) => t.id);

  const [
    usersById,
    cloudJobsByTaskId,
    inferenceUsageByTaskId,
    modelDisplayNames,
  ] = await Promise.all([
    getUsersById(userIds),
    getLatestCloudJobsByTaskId(taskIds),
    getTaskInferenceUsageByTaskIds(taskIds),
    getTaskModelDisplayNameMap(taskResults.map((task) => task.model)),
  ]);

  const enrichedTasks = taskResults
    .map((task) => {
      const displayUserId =
        task.effectiveAuthorKind === 'roomote'
          ? null
          : (task.effectiveAuthorUserId ?? task.attributedUserId);
      const user = displayUserId ? (usersById[displayUserId] ?? null) : null;
      const cloudJob = cloudJobsByTaskId[task.id];
      if (!cloudJob) {
        return null;
      }

      if (!hasTaskTypeFilter && isHiddenCloudTaskType(cloudJob.type)) {
        return null;
      }

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

      return {
        ...task,
        user,
        attributionLabel: attribution.productDisplay,
        attributionKind: attribution.kind,
        modelDisplayName: task.model ? modelDisplayNames.get(task.model) : null,
        cloudJob,
        inferenceUsage: inferenceUsageByTaskId[task.id],
      };
    })
    .filter((task): task is NonNullable<typeof task> => task !== null);

  // Calculate hasMore and nextCursor using limit + 1 pattern.
  const hasMore = enrichedTasks.length === limit + 1;
  const lastTask = hasMore ? enrichedTasks[limit - 1] : undefined;

  const nextCursor =
    lastTask !== undefined
      ? `${lastTask.activityAt}:${lastTask.id}` // Use the last item we'll return, not the extra one.
      : undefined;

  return {
    tasks: hasMore ? enrichedTasks.slice(0, limit) : enrichedTasks, // Slice down to the requested limit.
    hasMore,
    nextCursor,
  };
};

/**
 * Search Tasks
 *
 * Simple search by title with ILIKE, scoped to the user's tasks within their org.
 */

type SearchTaskResult = {
  id: string;
  title: string | null;
  timestamp: number;
  lastMessageAt: number;
  cloudJob: SimpleCloudJob;
};

export const searchTasks = async ({
  userId,
  query,
  limit = 10,
  includeIds,
}: {
  userId: string;
  query?: string;
  limit?: number;
  /** Task IDs that should always be included in the results (e.g. recently visited). */
  includeIds?: string[];
}): Promise<SearchTaskResult[]> => {
  const baseConditions = [
    eq(tasks.userId, userId),
    getVisibleTaskHistoryCondition(),
  ];

  const searchConditions = [...baseConditions];

  if (query && query.trim().length > 0) {
    const escaped = query.trim().replace(/%/g, '\\%').replace(/_/g, '\\_');
    searchConditions.push(sql`${tasks.title} ILIKE ${'%' + escaped + '%'}`);
  }

  // Main search query.
  const searchResults = await db
    .selectDistinct({
      id: tasks.id,
      title: tasks.title,
      timestamp: tasks.timestamp,
      activityAt: tasks.activityAt,
    })
    .from(tasks)
    .where(and(...searchConditions))
    .orderBy(desc(tasks.activityAt), desc(tasks.id))
    .limit(limit);

  // Fetch pinned tasks that aren't already in the search results.
  const searchResultIds = new Set(searchResults.map((t) => t.id));

  const missingIds = (includeIds ?? []).filter(
    (id) => !searchResultIds.has(id),
  );

  let pinnedResults: typeof searchResults = [];

  if (missingIds.length > 0) {
    pinnedResults = await db
      .selectDistinct({
        id: tasks.id,
        title: tasks.title,
        timestamp: tasks.timestamp,
        activityAt: tasks.activityAt,
      })
      .from(tasks)
      .where(and(...baseConditions, inArray(tasks.id, missingIds)))
      .orderBy(desc(tasks.activityAt), desc(tasks.id));
  }

  const results = [...searchResults, ...pinnedResults];
  const taskIds = results.map((t) => t.id);

  const cloudJobsByTaskId = await getLatestCloudJobsByTaskId(taskIds);

  return results
    .map((task) => {
      const cloudJob = cloudJobsByTaskId[task.id];

      if (!cloudJob || isHiddenCloudTaskType(cloudJob.type)) {
        return null;
      }

      const { activityAt, ...restTask } = task;
      return { ...restTask, lastMessageAt: activityAt, cloudJob };
    })
    .filter((task): task is NonNullable<typeof task> => task !== null);
};
