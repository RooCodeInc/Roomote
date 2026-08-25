import {
  type BackgroundAutomationKey,
  type TaskWorkflow,
  formatExternalActorLabel,
  getUserDisplayName,
  LINEAR_SESSION_ACTOR_PREFIX,
} from '@roomote/types';
import {
  type SQL,
  db,
  tasks,
  taskMessages,
  taskRuns,
  taskPullRequests,
  taskInferenceUsageEvents,
  users,
  eq,
  and,
  desc,
  asc,
  inArray,
  like,
  lt,
  isNull,
  isNotNull,
  not,
  sql,
} from '@roomote/db/server';

import {
  type Task as SimpleTask,
  type TaskCreatorKind,
  type TaskInferenceUsageSummary,
  type Filter,
  type TaskBoardColumn,
  type TimePeriodFilter,
  HAS_PULL_REQUEST_FILTER_VALUE,
} from '@/types';
import { getTaskCategoryById, isTaskWorkflow } from '@/lib';
import {
  formatAutomationAttributionLabel,
  parseCreatorFilterValue,
} from '@/lib/task-creator-filter';

import { type SimpleUser, getUsersById } from './users';
import { type SimpleTaskRun, getLatestTaskRunsByTaskId } from './task-runs';
import { getTaskModelDisplayNameMap } from './task-models';

/**
 * Task Filter Conditions
 */

type TaskFilterCondition = SQL<unknown>;

function getEffectiveFilters(
  filters: Filter[],
  { allowTaskTypeFilter }: { allowTaskTypeFilter: boolean },
): Filter[] {
  if (allowTaskTypeFilter) {
    return filters;
  }

  return filters.filter((filter) => filter.type !== 'taskType');
}

function getSelectedWorkflows(filters: Filter[]): TaskWorkflow[] {
  return [
    ...new Set(
      filters
        .filter((filter) => filter.type === 'taskType')
        .map((filter) => filter.value)
        .filter(isTaskWorkflow),
    ),
  ];
}

/**
 * Creator filters are a pure function of the tasks initiator columns.
 */
export function getCreatorFilterCondition(value: string): TaskFilterCondition {
  const creatorFilter = parseCreatorFilterValue(value);

  if (creatorFilter.kind === 'automation') {
    return and(
      eq(tasks.initiatorKind, 'automation'),
      // The filter value is user input; unknown keys simply match no rows.
      eq(
        tasks.initiatorAutomation,
        creatorFilter.key as BackgroundAutomationKey,
      ),
      creatorFilter.externalId
        ? eq(tasks.actorExternalId, creatorFilter.externalId)
        : undefined,
    )!;
  }

  if (creatorFilter.kind === 'external') {
    return and(
      eq(tasks.initiatorKind, 'user'),
      isNull(tasks.initiatorUserId),
      eq(tasks.actorExternalId, creatorFilter.externalId),
    )!;
  }

  if (creatorFilter.kind === 'linearAgent') {
    return and(
      eq(tasks.initiatorKind, 'user'),
      isNull(tasks.initiatorUserId),
      like(tasks.actorExternalId, `${LINEAR_SESSION_ACTOR_PREFIX}%`),
    )!;
  }

  return eq(tasks.initiatorUserId, creatorFilter.userId);
}

const getTaskFilterConditions = ({ filters }: { filters: Filter[] }) => {
  const conditions: TaskFilterCondition[] = [];
  const hasTaskTypeFilter = filters.some(
    (filter) => filter.type === 'taskType',
  );
  const selectedWorkflows = getSelectedWorkflows(filters);

  if (hasTaskTypeFilter) {
    if (selectedWorkflows.length === 0) {
      conditions.push(sql`1 = 0`);
    } else {
      conditions.push(inArray(tasks.workflow, selectedWorkflows));
    }
  }

  for (const filter of filters) {
    switch (filter.type) {
      case 'userId': {
        conditions.push(getCreatorFilterCondition(filter.value));
        break;
      }
      case 'category': {
        const taskCategory = getTaskCategoryById(filter.value);

        if (taskCategory) {
          conditions.push(inArray(tasks.workflow, taskCategory.workflows));
        }

        break;
      }
      case 'environmentId':
        conditions.push(
          sql`EXISTS (
            SELECT 1
            FROM ${taskRuns}
            WHERE ${taskRuns.taskId} = ${tasks.id}
              AND ${taskRuns.payload}->>'environmentId' = ${filter.value}
          )`,
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

function getTaskBoardColumnCondition(
  boardColumn: TaskBoardColumn,
): TaskFilterCondition {
  const latestTaskPhase = sql<string | null>`(
    SELECT ${taskRuns.taskPhase}
    FROM ${taskRuns}
    WHERE ${taskRuns.taskId} = ${tasks.id}
    ORDER BY ${taskRuns.id} DESC
    LIMIT 1
  )`;
  const needsInput = sql<boolean>`COALESCE(
    ${tasks.state} = 'active'
      AND ${latestTaskPhase} = 'waiting_for_user_input',
    FALSE
  )`;
  const blocked = sql<boolean>`COALESCE(
    ${tasks.state} = 'failed'
      OR ${tasks.goalStatus} IN ('blocked', 'budget_limited'),
    FALSE
  )`;
  const done = sql<boolean>`COALESCE(
    ${tasks.state} IN ('completed', 'canceled')
      OR ${tasks.goalStatus} = 'complete',
    FALSE
  )`;

  switch (boardColumn) {
    case 'needs-input':
      return needsInput;
    case 'blocked':
      return and(not(needsInput), blocked)!;
    case 'done':
      return and(not(needsInput), not(blocked), done)!;
    case 'active':
      return and(not(needsInput), not(blocked), not(done))!;
  }
}

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
 * Task creator display: a pure function of the tasks initiator columns.
 * - automation -> the automation key (humanized label)
 * - user + linked user -> the user's name/avatar
 * - user + no linked user -> the frozen external actor display
 */
export function resolveTaskCreatorDisplay(
  task: {
    initiatorKind: 'user' | 'automation';
    initiatorAutomation: string | null;
    actorExternalId: string | null;
    actorDisplayName: string | null;
  },
  user: { name: string | null; email: string | null } | null,
): { kind: TaskCreatorKind; label: string } {
  if (task.initiatorKind === 'automation') {
    return {
      kind: 'automation',
      label: task.initiatorAutomation
        ? formatAutomationAttributionLabel(task.initiatorAutomation, {
            actorDisplayName: task.actorDisplayName,
          })
        : '',
    };
  }

  if (user) {
    return { kind: 'user', label: getUserDisplayName(user) ?? '' };
  }

  return {
    kind: 'external',
    label: formatExternalActorLabel(task) ?? '',
  };
}

/**
 * Get Tasks
 */

export type Task = SimpleTask & {
  attributionLabel: string;
  attributionKind: TaskCreatorKind;
  modelDisplayName?: string | null;
  user: SimpleUser | null;
  taskRun: SimpleTaskRun;
  participants: SimpleUser[];
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

async function getTaskParticipantsByTaskIds(
  taskIds: string[],
): Promise<Record<string, SimpleUser[]>> {
  if (taskIds.length === 0) {
    return {};
  }

  const results = await db
    .selectDistinctOn([taskMessages.taskId, taskMessages.userId], {
      taskId: taskMessages.taskId,
      id: users.id,
      name: users.name,
      email: users.email,
      imageUrl: users.imageUrl,
    })
    .from(taskMessages)
    .innerJoin(users, eq(users.id, taskMessages.userId))
    .where(
      and(
        inArray(taskMessages.taskId, taskIds),
        eq(taskMessages.role, 'user'),
        isNotNull(taskMessages.userId),
      ),
    )
    .orderBy(
      asc(taskMessages.taskId),
      asc(taskMessages.userId),
      asc(taskMessages.createdAt),
    );

  const participantsByTaskId: Record<string, SimpleUser[]> = {};

  for (const participant of results) {
    const participants = participantsByTaskId[participant.taskId] ?? [];
    participants.push({
      id: participant.id,
      name: participant.name,
      email: participant.email,
      imageUrl: participant.imageUrl,
    });
    participantsByTaskId[participant.taskId] = participants;
  }

  return participantsByTaskId;
}

export const getTasks = async ({
  limit = 30,
  cursor,
  filters = [],
  timePeriod = 'all',
  boardColumn,
  allowTaskTypeFilter = false,
}: {
  userId: string;
  isAdmin?: boolean;
  limit?: number;
  cursor?: string | number;
  filters?: Filter[];
  timePeriod?: TimePeriodFilter;
  boardColumn?: TaskBoardColumn;
  allowTaskTypeFilter?: boolean;
}): Promise<GetTasksResult> => {
  const effectiveFilters = getEffectiveFilters(filters, {
    allowTaskTypeFilter,
  });
  const hasTaskTypeFilter = effectiveFilters.some(
    (filter) => filter.type === 'taskType',
  );
  const conditions: TaskFilterCondition[] = [isNull(tasks.deletedAt)];

  // An explicit workflow filter is the only way to reveal hidden tasks.
  if (!hasTaskTypeFilter) {
    conditions.push(eq(tasks.visibility, 'visible'));
  }

  conditions.push(...getTaskFilterConditions({ filters: effectiveFilters }));

  if (boardColumn) {
    conditions.push(getTaskBoardColumnCondition(boardColumn));
  }

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

  // Single-table read: display identity, classification, and state are all
  // columns on tasks. The latest-run join happens separately and only feeds
  // live runtime status/phase/preview fields.
  const taskResults = await db
    .select({
      id: tasks.id,
      harnessSessionId: tasks.harnessSessionId,
      initiatorKind: tasks.initiatorKind,
      initiatorUserId: tasks.initiatorUserId,
      initiatorAutomation: tasks.initiatorAutomation,
      actorExternalId: tasks.actorExternalId,
      actorDisplayName: tasks.actorDisplayName,
      title: tasks.title,
      model: tasks.model,
      mode: tasks.mode,
      state: tasks.state,
      goalStatus: tasks.goalStatus,
      goalBlockedReason: tasks.goalBlockedReason,
      workflow: tasks.workflow,
      surface: tasks.surface,
      timestamp: tasks.timestamp,
      activityAt: tasks.activityAt,
      repositoryUrl: tasks.repositoryUrl,
      repositoryName: tasks.repositoryName,
      defaultBranch: tasks.defaultBranch,
    })
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.activityAt), desc(tasks.id))
    .limit(limit + 1); // Request one extra to determine hasMore.

  // Fetch associations (users, latest runs, usage) in parallel.
  const userIds = [
    ...new Set(
      taskResults
        .map((t) => t.initiatorUserId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const taskIds = taskResults.map((t) => t.id);

  const [
    usersById,
    taskRunsByTaskId,
    inferenceUsageByTaskId,
    participantsByTaskId,
    modelDisplayNames,
  ] = await Promise.all([
    getUsersById(userIds),
    getLatestTaskRunsByTaskId(taskIds),
    getTaskInferenceUsageByTaskIds(taskIds),
    getTaskParticipantsByTaskIds(taskIds),
    getTaskModelDisplayNameMap(taskResults.map((task) => task.model)),
  ]);

  const enrichedTasks = taskResults
    .map((task) => {
      const user = task.initiatorUserId
        ? (usersById[task.initiatorUserId] ?? null)
        : null;
      const taskRun = taskRunsByTaskId[task.id];

      if (!taskRun) {
        return null;
      }

      const creator = resolveTaskCreatorDisplay(task, user);

      return {
        ...task,
        user,
        attributionLabel: creator.label,
        attributionKind: creator.kind,
        modelDisplayName: task.model ? modelDisplayNames.get(task.model) : null,
        taskRun,
        participants: (participantsByTaskId[task.id] ?? []).filter(
          (participant) => participant.id !== task.initiatorUserId,
        ),
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
 * Simple search by title with ILIKE, scoped to tasks initiated by the
 * current user (matches the default tasks list). Explicit `includeIds`
 * ensure the user's pinned / recently visited tasks are included.
 */

type SearchTaskResult = {
  id: string;
  title: string | null;
  timestamp: number;
  lastMessageAt: number;
  taskRun: SimpleTaskRun;
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
  const visibleConditions = [
    isNull(tasks.deletedAt),
    eq(tasks.visibility, 'visible'),
  ];

  const searchConditions = [
    ...visibleConditions,
    eq(tasks.initiatorUserId, userId),
  ];

  if (query && query.trim().length > 0) {
    const escaped = query
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    searchConditions.push(sql`${tasks.title} ILIKE ${'%' + escaped + '%'}`);
  }

  // Main search query: only the current user's tasks.
  const searchResults = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      timestamp: tasks.timestamp,
      activityAt: tasks.activityAt,
    })
    .from(tasks)
    .where(and(...searchConditions))
    .orderBy(desc(tasks.activityAt), desc(tasks.id))
    .limit(limit);

  // Fetch the current user's pinned / visited tasks that aren't already in the
  // search results.
  const searchResultIds = new Set(searchResults.map((t) => t.id));

  const missingIds = (includeIds ?? []).filter(
    (id) => !searchResultIds.has(id),
  );

  let pinnedResults: typeof searchResults = [];

  if (missingIds.length > 0) {
    pinnedResults = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        timestamp: tasks.timestamp,
        activityAt: tasks.activityAt,
      })
      .from(tasks)
      .where(
        and(
          ...visibleConditions,
          eq(tasks.initiatorUserId, userId),
          inArray(tasks.id, missingIds),
        ),
      )
      .orderBy(desc(tasks.activityAt), desc(tasks.id));
  }

  const results = [...searchResults, ...pinnedResults];
  const taskIds = results.map((t) => t.id);

  const taskRunsByTaskId = await getLatestTaskRunsByTaskId(taskIds);

  return results
    .map((task) => {
      const taskRun = taskRunsByTaskId[task.id];

      if (!taskRun) {
        return null;
      }

      const { activityAt, ...restTask } = task;
      return { ...restTask, lastMessageAt: activityAt, taskRun };
    })
    .filter((task): task is NonNullable<typeof task> => task !== null);
};
