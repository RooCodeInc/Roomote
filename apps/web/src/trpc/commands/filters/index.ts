import {
  db,
  tasks,
  users,
  environments,
  taskRuns,
  taskPullRequests,
  eq,
  sql,
  and,
  isNotNull,
  isNull,
  desc,
  max,
  not,
  inArray,
} from '@roomote/db/server';

import {
  ALL_REPOSITORIES,
  formatExternalActorLabel,
  type TaskSurface,
  getTaskModelDisplayName,
} from '@roomote/types';

import type { TimePeriodFilter, UserAuthSuccess } from '@/types';
import { getTaskCategoryById, getUserDisplayName } from '@/lib';
import {
  buildCreatorFilterValue,
  formatAutomationLabel,
} from '@/lib/task-creator-filter';
import { getTaskSurfaceLabel } from '@/lib/task-surface-label';
import { getCreatorFilterCondition } from '@/lib/server/tasks';

type FilterOption = { value: string; label: string; subLabel?: string };

function formatPrRepoName(repo: string): string {
  return repo === ALL_REPOSITORIES ? 'All Repositories' : repo;
}

const getTimePeriodCutoff = (timePeriod: number): number =>
  Math.floor(Date.now() / 1000) - timePeriod * 24 * 60 * 60;

function getVisibleTaskHistoryConditions() {
  return [eq(tasks.visibility, 'visible'), isNull(tasks.deletedAt)];
}

function getSurfaceSubLabel(surface: TaskSurface | null): string | undefined {
  return getTaskSurfaceLabel(surface);
}

function getCategoryCondition(category: string | null | undefined) {
  const taskCategory = getTaskCategoryById(category);

  return taskCategory ? [inArray(tasks.workflow, taskCategory.workflows)] : [];
}

export async function getUsersOnlyForFilterCommand(
  auth: UserAuthSuccess,
  input: {
    repositoryName?: string | null;
    category?: string | null;
    timePeriod?: TimePeriodFilter;
  },
): Promise<FilterOption[]> {
  void auth;
  const whereConditions = [...getVisibleTaskHistoryConditions()];

  if (input.repositoryName) {
    whereConditions.push(eq(tasks.repositoryName, input.repositoryName));
  }

  whereConditions.push(...getCategoryCondition(input.category));

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    whereConditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  // Distinct initiator identities straight off the tasks columns.
  const initiatorRows = await db
    .selectDistinct({
      initiatorKind: tasks.initiatorKind,
      initiatorUserId: tasks.initiatorUserId,
      initiatorAutomation: tasks.initiatorAutomation,
      actorExternalId: tasks.actorExternalId,
      actorDisplayName: tasks.actorDisplayName,
      surface: tasks.surface,
      userName: users.name,
      userEmail: users.email,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.initiatorUserId))
    .where(and(...whereConditions));

  const optionsByValue = new Map<string, FilterOption>();

  for (const row of initiatorRows) {
    const value = buildCreatorFilterValue(row);

    if (!value || optionsByValue.has(value)) {
      continue;
    }

    if (row.initiatorKind === 'automation') {
      optionsByValue.set(value, {
        value,
        label:
          value === 'automation:custom_automation'
            ? 'Custom Automations (All)'
            : row.initiatorAutomation
              ? formatAutomationLabel(row.initiatorAutomation, {
                  actorDisplayName: row.actorDisplayName,
                })
              : '',
        subLabel: 'Automation',
      });
    } else if (row.initiatorUserId) {
      optionsByValue.set(value, {
        value,
        label:
          getUserDisplayName({
            name: row.userName,
            email: row.userEmail,
          }) ?? '',
      });
    } else {
      optionsByValue.set(value, {
        value,
        label: formatExternalActorLabel(row) ?? '',
        subLabel: getSurfaceSubLabel(row.surface),
      });
    }
  }

  return [...optionsByValue.values()]
    .filter((option) => option.label)
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function getEnvironmentsForFilterCommand(
  auth: UserAuthSuccess,
): Promise<FilterOption[]> {
  void auth;

  const results = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(and(isNull(environments.userId), eq(environments.isEval, false)))
    .orderBy(environments.name);

  return results.map((r) => ({ value: r.id, label: r.name }));
}

export async function getRepositoriesForFilterCommand(
  auth: UserAuthSuccess,
  input: {
    userId?: string | null;
    category?: string | null;
    timePeriod?: TimePeriodFilter;
  },
): Promise<FilterOption[]> {
  void auth;
  const conditions = [...getVisibleTaskHistoryConditions()];

  if (input.userId) {
    conditions.push(getCreatorFilterCondition(input.userId));
  }

  conditions.push(...getCategoryCondition(input.category));

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    conditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  conditions.push(isNotNull(tasks.repositoryName));
  conditions.push(sql`${tasks.repositoryName} != ''`);

  const environmentIds = await db.query.environments.findMany({
    columns: { id: true },
    where: eq(environments.isEval, false),
  });

  if (environmentIds.length > 0) {
    conditions.push(
      not(
        inArray(
          tasks.repositoryName,
          environmentIds.map(({ id }) => id),
        ),
      ),
    );
  }

  const results = await db
    .select({ repositoryName: tasks.repositoryName })
    .from(tasks)
    .where(and(...conditions))
    .groupBy(tasks.repositoryName)
    .orderBy(tasks.repositoryName);

  return results
    .filter((r) => r.repositoryName)
    .map((r) => ({ value: r.repositoryName!, label: r.repositoryName! }));
}

export async function getPullRequestsForFilterCommand(
  auth: UserAuthSuccess,
  input: {
    userId?: string | null;
    category?: string | null;
    repositoryName?: string | null;
    timePeriod?: TimePeriodFilter;
    search?: string;
  },
): Promise<FilterOption[]> {
  void auth;
  const whereConditions = [...getVisibleTaskHistoryConditions()];

  if (input.repositoryName) {
    whereConditions.push(eq(tasks.repositoryName, input.repositoryName));
  }

  if (input.userId) {
    whereConditions.push(getCreatorFilterCondition(input.userId));
  }

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    whereConditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  whereConditions.push(...getCategoryCondition(input.category));

  whereConditions.push(isNotNull(taskPullRequests.repository));
  whereConditions.push(isNotNull(taskPullRequests.prNumber));

  const trimmedSearch = input.search?.trim();

  if (trimmedSearch) {
    const searchNumber = parseInt(trimmedSearch, 10);

    if (!isNaN(searchNumber)) {
      whereConditions.push(eq(taskPullRequests.prNumber, searchNumber));
    }
  }

  const latestPrTitle = max(taskPullRequests.prTitle).as('latest_pr_title');

  const latestDetectedAt = max(taskPullRequests.detectedAt).as(
    'latest_detected_at',
  );

  const results = await db
    .select({
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      prTitle: latestPrTitle,
      latestDetectedAt,
    })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .where(and(...whereConditions))
    .groupBy(taskPullRequests.repository, taskPullRequests.prNumber)
    .orderBy(desc(latestDetectedAt))
    .limit(20);

  return results
    .filter(
      (
        r,
      ): r is typeof r & {
        repository: string;
        prNumber: number;
      } => !!r.repository && r.prNumber !== null,
    )
    .map((r) => {
      const value = `${r.repository}#${r.prNumber}`;
      const label = r.prTitle || `#${r.prNumber}`;
      const subLabel = `${formatPrRepoName(r.repository)}#${r.prNumber}`;
      return { value, label, subLabel };
    });
}

export async function getModelsForFilterCommand(
  auth: UserAuthSuccess,
  input: {
    userId?: string | null;
    category?: string | null;
    repositoryName?: string | null;
    timePeriod?: TimePeriodFilter;
  },
): Promise<FilterOption[]> {
  void auth;
  const conditions = [...getVisibleTaskHistoryConditions()];

  if (input.repositoryName) {
    if (input.repositoryName.startsWith('env:')) {
      const environmentId = input.repositoryName.slice(4);

      conditions.push(
        sql`EXISTS (
          SELECT 1
          FROM ${taskRuns}
          WHERE ${taskRuns.taskId} = ${tasks.id}
            AND ${taskRuns.payload}->>'environmentId' = ${environmentId}
        )`,
      );
    } else {
      conditions.push(eq(tasks.repositoryName, input.repositoryName));
    }
  }

  if (input.userId) {
    conditions.push(getCreatorFilterCondition(input.userId));
  }

  conditions.push(...getCategoryCondition(input.category));

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    conditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  const results = await db
    .select({ model: tasks.model })
    .from(tasks)
    .where(and(...conditions))
    .groupBy(tasks.model)
    .orderBy(tasks.model);

  return results
    .filter(
      (result): result is typeof result & { model: string } => !!result.model,
    )
    .map((result) => ({
      value: result.model,
      label: getTaskModelDisplayName(result.model),
      ...(getTaskModelDisplayName(result.model) !== result.model
        ? { subLabel: result.model }
        : {}),
    }));
}
