import {
  db,
  tasks,
  users,
  cloudJobs,
  environments,
  taskPullRequests,
  eq,
  sql,
  and,
  isNotNull,
  isNull,
  or,
  desc,
  max,
  not,
  inArray,
  isVisibleTask,
} from '@roomote/db/server';

import {
  ALL_REPOSITORIES,
  PRODUCT_NAME,
  getTaskModelDisplayName,
} from '@roomote/types';

import type { TimePeriodFilter, UserAuthSuccess } from '@/types';
import { getTaskCategoryById, getUserDisplayName } from '@/lib';
import {
  AUTOMATIONS_CREATOR_FILTER_LABEL,
  AUTOMATIONS_CREATOR_FILTER_VALUE,
  buildAutomationCreatorFilterValue,
  buildMatchedUserCreatorFilterValue,
  buildUnlinkedCreatorFilterValue,
} from '@/lib/task-creator-filter';
import {
  automationInitiatedTaskCondition,
  buildTaskCreatorFilterCondition,
} from '@/lib/server/task-creator-filter-condition';

type FilterOption = { value: string; label: string; subLabel?: string };

function formatPrRepoName(repo: string): string {
  return repo === ALL_REPOSITORIES ? 'All Repositories' : repo;
}

const getTimePeriodCutoff = (timePeriod: number): number =>
  Math.floor(Date.now() / 1000) - timePeriod * 24 * 60 * 60;

function getVisibleTaskHistoryCondition() {
  // `isVisibleTask` constructs a DB-backed subquery, so keep it out of module
  // scope until apps/web has explicitly initialized the database singleton.
  return isVisibleTask(tasks.id);
}

function getAttributionSourceLabel(
  sourceKind: string | null,
): string | undefined {
  switch (sourceKind) {
    case 'slack':
      return 'Slack';
    case 'github':
      return 'GitHub';
    case 'linear':
      return 'Linear';
    case 'web':
      return 'Web';
    case 'automation':
      return 'Automation';
    default:
      return undefined;
  }
}

export async function getUsersOnlyForFilterCommand(
  auth: UserAuthSuccess,
  input: {
    repositoryName?: string | null;
    category?: string | null;
    timePeriod?: TimePeriodFilter;
  },
): Promise<FilterOption[]> {
  const whereConditions = [];
  const taskCategory = getTaskCategoryById(input.category);

  if (input.repositoryName) {
    whereConditions.push(eq(tasks.repositoryName, input.repositoryName));
  }

  if (taskCategory) {
    whereConditions.push(inArray(cloudJobs.type, [...taskCategory.taskTypes]));
  }

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    whereConditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  whereConditions.push(getVisibleTaskHistoryCondition());

  const matchedUsersQuery = db
    .select({
      userId: tasks.effectiveAuthorUserId,
      username: users.name,
      userEmail: users.email,
    })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.effectiveAuthorUserId));

  const matchedUserResults = await (
    taskCategory
      ? matchedUsersQuery.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : matchedUsersQuery
  )
    .where(
      and(
        ...whereConditions,
        eq(tasks.effectiveAuthorKind, 'human'),
        isNotNull(tasks.effectiveAuthorUserId),
      ),
    )
    .groupBy(tasks.effectiveAuthorUserId, users.name, users.email)
    .orderBy(users.name, users.email);

  const legacyMatchedUsersQuery = db
    .select({
      userId: tasks.attributedUserId,
      username: users.name,
      userEmail: users.email,
    })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.attributedUserId));

  const legacyMatchedUserResults = await (
    taskCategory
      ? legacyMatchedUsersQuery.leftJoin(
          cloudJobs,
          eq(cloudJobs.taskId, tasks.id),
        )
      : legacyMatchedUsersQuery
  )
    .where(
      and(
        ...whereConditions,
        isNull(tasks.effectiveAuthorKind),
        isNotNull(tasks.attributedUserId),
      ),
    )
    .groupBy(tasks.attributedUserId, users.name, users.email)
    .orderBy(users.name, users.email);

  const unlinkedUsersQuery = db
    .select({
      attributionKind: tasks.attributionKind,
      sourceKind: tasks.attributionSourceKind,
      sourceDisplayName: tasks.attributionSourceDisplayName,
      sourceExternalId: tasks.attributionSourceExternalId,
    })
    .from(tasks);

  const unlinkedUserResults = await (
    taskCategory
      ? unlinkedUsersQuery.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : unlinkedUsersQuery
  )
    .where(
      and(
        ...whereConditions,
        eq(tasks.attributionKind, 'unlinked_user'),
        or(
          isNull(tasks.effectiveAuthorKind),
          and(
            eq(tasks.effectiveAuthorKind, 'human'),
            isNull(tasks.effectiveAuthorUserId),
          ),
        ),
        isNotNull(tasks.attributionSourceKind),
        isNotNull(tasks.attributionSourceExternalId),
      ),
    )
    .groupBy(
      tasks.attributionKind,
      tasks.attributionSourceKind,
      tasks.attributionSourceDisplayName,
      tasks.attributionSourceExternalId,
    )
    .orderBy(
      tasks.attributionSourceDisplayName,
      tasks.attributionSourceExternalId,
    );

  const automationsQuery = db
    .select({
      sourceDisplayName: tasks.attributionSourceDisplayName,
    })
    .from(tasks);

  const automationResults = await (
    taskCategory
      ? automationsQuery.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : automationsQuery
  )
    .where(and(...whereConditions, automationInitiatedTaskCondition()))
    .groupBy(tasks.attributionSourceDisplayName)
    .orderBy(tasks.attributionSourceDisplayName);

  const matchedUserOptions: FilterOption[] = [
    ...matchedUserResults,
    ...legacyMatchedUserResults,
  ]
    .map((result) => ({
      value: buildMatchedUserCreatorFilterValue(result.userId!),
      label:
        getUserDisplayName({
          name: result.username,
          email: result.userEmail,
        }) ?? '',
    }))
    .filter(
      (option, index, options) =>
        options.findIndex((candidate) => candidate.value === option.value) ===
        index,
    );

  const unlinkedUserOptions: FilterOption[] = unlinkedUserResults.flatMap(
    (result) => {
      const value = buildUnlinkedCreatorFilterValue({
        attributionSourceKind: result.sourceKind,
        attributionSourceExternalId: result.sourceExternalId,
      });

      if (!value) {
        return [];
      }

      return [
        {
          value,
          label: result.sourceDisplayName ?? result.sourceExternalId ?? '',
          subLabel: getAttributionSourceLabel(result.sourceKind),
        },
      ];
    },
  );

  const namedAutomationLabels = new Set<string>();
  let hasUnnamedAutomations = false;

  for (const result of automationResults) {
    const label = result.sourceDisplayName?.trim();

    if (
      !label ||
      label === PRODUCT_NAME ||
      label === AUTOMATIONS_CREATOR_FILTER_LABEL
    ) {
      hasUnnamedAutomations = true;
    } else {
      namedAutomationLabels.add(label);
    }
  }

  const automationOptions: FilterOption[] = [
    ...[...namedAutomationLabels].map((label) => ({
      value: buildAutomationCreatorFilterValue(label),
      label,
      subLabel: getAttributionSourceLabel('automation'),
    })),
    ...(hasUnnamedAutomations
      ? [
          {
            value: AUTOMATIONS_CREATOR_FILTER_VALUE,
            label: AUTOMATIONS_CREATOR_FILTER_LABEL,
          },
        ]
      : []),
  ];

  return [
    ...matchedUserOptions,
    ...unlinkedUserOptions,
    ...automationOptions,
  ].sort((left, right) => left.label.localeCompare(right.label));
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
  const conditions = [];
  const taskCategory = getTaskCategoryById(input.category);

  if (input.userId) {
    conditions.push(buildTaskCreatorFilterCondition(input.userId));
  }

  if (taskCategory) {
    conditions.push(inArray(cloudJobs.type, [...taskCategory.taskTypes]));
  }

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    conditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  conditions.push(isNotNull(tasks.repositoryName));
  conditions.push(sql`${tasks.repositoryName} != ''`);
  conditions.push(getVisibleTaskHistoryCondition());

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

  const repositoriesQuery = db
    .select({ repositoryName: tasks.repositoryName })
    .from(tasks);

  const results = await (
    taskCategory
      ? repositoriesQuery.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : repositoriesQuery
  )
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
  const whereConditions = [];
  const taskCategory = getTaskCategoryById(input.category);

  if (input.repositoryName) {
    whereConditions.push(eq(tasks.repositoryName, input.repositoryName));
  }

  if (input.userId) {
    whereConditions.push(buildTaskCreatorFilterCondition(input.userId));
  }

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    whereConditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  if (taskCategory) {
    whereConditions.push(inArray(cloudJobs.type, [...taskCategory.taskTypes]));
  }

  whereConditions.push(isNotNull(taskPullRequests.repository));
  whereConditions.push(isNotNull(taskPullRequests.prNumber));
  whereConditions.push(getVisibleTaskHistoryCondition());

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

  const query = db
    .select({
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      prTitle: latestPrTitle,
      latestDetectedAt,
    })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id));

  const baseQuery = (
    taskCategory
      ? query.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : query
  )
    .where(and(...whereConditions))
    .groupBy(taskPullRequests.repository, taskPullRequests.prNumber)
    .orderBy(desc(latestDetectedAt))
    .limit(20);

  const results = await baseQuery;

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
  const conditions = [];
  const taskCategory = getTaskCategoryById(input.category);

  if (input.repositoryName) {
    if (input.repositoryName.startsWith('env:')) {
      conditions.push(
        sql`${cloudJobs.payload}->>'environmentId' = ${input.repositoryName.slice(4)}`,
      );
    } else {
      conditions.push(eq(tasks.repositoryName, input.repositoryName));
    }
  }

  if (input.userId) {
    conditions.push(buildTaskCreatorFilterCondition(input.userId));
  }

  if (taskCategory) {
    conditions.push(inArray(cloudJobs.type, [...taskCategory.taskTypes]));
  }

  if (input.timePeriod && input.timePeriod !== 'all') {
    const cutoffTimestamp = getTimePeriodCutoff(input.timePeriod);
    conditions.push(sql`${tasks.timestamp} >= ${cutoffTimestamp}`);
  }

  conditions.push(getVisibleTaskHistoryCondition());

  const query = db.select({ model: tasks.model }).from(tasks);
  const results = await (
    taskCategory || input.repositoryName?.startsWith('env:')
      ? query.leftJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
      : query
  )
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
