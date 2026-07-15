import {
  addDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  eachYearOfInterval,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
} from 'date-fns';
import * as GitHub from '@roomote/github';
import { syncGitHubPullRequestFactsForOrg } from '@roomote/sdk/server';

import {
  ALL_REPOSITORIES,
  type PullRequestStatus,
  PRODUCT_NAME,
  type TaskSurface,
} from '@roomote/types';
import {
  db,
  tasks,
  taskRuns,
  users,
  taskPullRequests,
  githubUserMappings,
  environments,
  llmUsageEvents,
  alias,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from '@roomote/db/server';

import {
  type AnalyticsChartBucket,
  type AnalyticsChartResponse,
  type AnalyticsCostBreakdownRow,
  type AnalyticsCostSummary,
  type AnalyticsDetailsColumn,
  type AnalyticsDetailsResponse,
  type AnalyticsDetailsRow,
  type AnalyticsDimension,
  type AnalyticsExportResponse,
  type AnalyticsFilterOption,
  type AnalyticsFilterOptionsResponse,
  type AnalyticsFilters,
  type AnalyticsGranularity,
  type AnalyticsMetric,
  type AnalyticsObject,
  type AnalyticsSeries,
  type PullRequestAnalyticsOverviewResponse,
  type PullRequestAnalyticsSummary,
  type TimePeriodFilter,
  ANALYTICS_OBJECT_CONFIG,
  getDefaultAnalyticsGranularity,
  getDefaultAnalyticsMetric,
  getDefaultAnalyticsViewBy,
  isValidAnalyticsGranularity,
  isValidAnalyticsMetric,
  isValidAnalyticsViewBy,
} from '@/types';

import type { UserAuthSuccess } from '@/types';
import { getUserDisplayName } from '@/lib/user-display-name';
import { formatAutomationLabel } from '@/lib/task-creator-filter';

import { getLatestTaskRunsByTaskId } from './task-runs';
import { getRepositories } from './source-control';
import {
  getPullRequestFactRepositoryIdsNeedingBackfill,
  getStoredPullRequestsForAnalytics,
} from './pull-request-facts';

const SYSTEM_SOURCE = 'System';
const UNKNOWN_REPO_LABEL = 'Unknown Repo';
const NO_PROJECT_LABEL = 'No Environment';
const NO_VALUE_LABEL = '—';
const ALL_REPOS_LABEL = 'All Repos';
const WEEK_OPTIONS = { weekStartsOn: 1 as const };
const ROOMOTE_CREATED_BY_LABEL = PRODUCT_NAME;
const HUMAN_CREATED_BY_LABEL = 'Human';
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

const SOURCE_ORDER = [
  'Slack',
  'Teams',
  'Telegram',
  'GitHub',
  'GitLab',
  'Gitea',
  'Bitbucket',
  'Azure DevOps',
  'Linear',
  'Web',
  'API',
  SYSTEM_SOURCE,
];
const PR_STATUS_ORDER = ['Closed', 'Draft', 'Open', 'Merged'] as const;

type AnalyticsDimensionValue = {
  key: string;
  label: string;
  disambiguationLabel?: string;
};

const usageUsers = alias(users, 'analytics_usage_users');
const taskInitiatorUsers = alias(users, 'analytics_task_initiator_users');

type AnalyticsRow = {
  id: string;
  timestamp: Date;
  value: number;
  dimensions: Partial<Record<AnalyticsDimension, AnalyticsDimensionValue>>;
  details: AnalyticsDetailsRow;
  meta?: {
    authorLogin?: string | null;
    canonicalTaskId?: string | null;
    isMerged?: boolean;
    isRoomote?: boolean;
    prKeys?: string[];
  };
};

type PullRequestAnalyticsRow = AnalyticsRow & {
  meta: {
    authorLogin: string | null;
    canonicalTaskId: string | null;
    isMerged: boolean;
    isRoomote: boolean;
  };
};

function formatAnalyticsDateTime(timestamp: Date) {
  return format(timestamp, 'MMM d, yyyy h:mm a');
}

function getRequestTimeBootstrapCutoff(
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Date | null {
  if (!timePeriod || timePeriod === 'all') {
    return null;
  }

  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (timePeriod - 1));
  return cutoff;
}

function getResolvedGranularity(
  timePeriod: TimePeriodFilter | undefined,
  requestedGranularity: AnalyticsGranularity | undefined,
): AnalyticsGranularity {
  const normalizedTimePeriod = timePeriod ?? 7;

  if (
    requestedGranularity &&
    isValidAnalyticsGranularity(normalizedTimePeriod, requestedGranularity)
  ) {
    return requestedGranularity;
  }

  return getDefaultAnalyticsGranularity(normalizedTimePeriod);
}

function getTimeCutoff(
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Date | null {
  if (!timePeriod || timePeriod === 'all') {
    return null;
  }

  return startOfDay(subDays(now, timePeriod - 1));
}

function getExpectedBuckets(
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
  granularity: AnalyticsGranularity,
  firstDataBucketStart: Date | null,
): Date[] {
  if (!timePeriod || timePeriod === 'all') {
    return [];
  }

  const end = startOfDay(now);
  const cutoffStart = getTimeCutoff(timePeriod, now);

  if (!cutoffStart) {
    return [];
  }

  const start =
    firstDataBucketStart && firstDataBucketStart > cutoffStart
      ? firstDataBucketStart
      : cutoffStart;

  if (start > end) {
    return [];
  }

  switch (granularity) {
    case 'year':
      return eachYearOfInterval({ start, end });
    case 'month':
      return eachMonthOfInterval({ start, end });
    case 'week':
      return eachWeekOfInterval({ start, end }, WEEK_OPTIONS);
    case 'day':
    default:
      return eachDayOfInterval({ start, end });
  }
}

function getBucketCountForRange(
  start: Date,
  end: Date,
  granularity: AnalyticsGranularity,
) {
  if (start > end) {
    return 0;
  }

  switch (granularity) {
    case 'year':
      return eachYearOfInterval({ start, end }).length;
    case 'month':
      return eachMonthOfInterval({ start, end }).length;
    case 'week':
      return eachWeekOfInterval({ start, end }, WEEK_OPTIONS).length;
    case 'day':
    default:
      return eachDayOfInterval({ start, end }).length;
  }
}

function getSummaryRange(
  rows: PullRequestAnalyticsRow[],
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
) {
  const end = startOfDay(now);
  const explicitCutoff = getTimeCutoff(timePeriod, now);

  if (explicitCutoff) {
    return {
      start: explicitCutoff,
      end,
    };
  }

  const firstTimestamp = rows.reduce<Date | null>((earliest, row) => {
    if (!earliest || row.timestamp < earliest) {
      return row.timestamp;
    }

    return earliest;
  }, null);

  if (!firstTimestamp) {
    return null;
  }

  return {
    start: startOfDay(firstTimestamp),
    end,
  };
}

function getSummaryPeriodCount(
  rows: PullRequestAnalyticsRow[],
  timePeriod: TimePeriodFilter | undefined,
  granularity: AnalyticsGranularity,
  now: Date,
) {
  const summaryRange = getSummaryRange(rows, timePeriod, now);

  if (!summaryRange) {
    return 0;
  }

  const elapsedDays = getBucketCountForRange(
    summaryRange.start,
    summaryRange.end,
    'day',
  );

  switch (granularity) {
    case 'week':
      return elapsedDays / DAYS_PER_WEEK;
    case 'month':
      return elapsedDays / DAYS_PER_MONTH;
    case 'year':
      return elapsedDays / DAYS_PER_YEAR;
    case 'day':
    default:
      return elapsedDays;
  }
}

function formatUserLabel(
  user: { name: string | null; email: string | null } | null,
) {
  return getUserDisplayName(user) || PRODUCT_NAME;
}

function formatDisambiguatedUserLabel(
  user: { name: string | null; email: string | null } | null,
) {
  const displayName = getUserDisplayName(user);

  if (displayName && user?.email) {
    return `${displayName} (${user.email})`;
  }

  return formatUserLabel(user);
}

function createDimensionValue(
  key: string,
  label: string,
  disambiguationLabel?: string,
): AnalyticsDimensionValue {
  return {
    key,
    label,
    ...(disambiguationLabel &&
    disambiguationLabel !== label &&
    disambiguationLabel.trim()
      ? { disambiguationLabel }
      : {}),
  };
}

function createLabelBackedDimensionValue(label: string) {
  return createDimensionValue(label, label);
}

function getCanonicalUserDimensionValue(user: {
  id: string | null;
  name: string | null;
  email: string | null;
}) {
  const label = formatUserLabel(user);
  const normalizedEmail = user.email?.trim().toLowerCase() ?? null;
  const key = user.id
    ? `user:${user.id}`
    : normalizedEmail
      ? `email:${normalizedEmail}`
      : PRODUCT_NAME;

  return createDimensionValue(key, label, formatDisambiguatedUserLabel(user));
}

/**
 * Creator dimension: a pure function of the tasks initiator columns
 * (GROUP BY initiatorKind + COALESCE(initiatorUserId, initiatorAutomation,
 * actorExternalId) semantics, computed per row).
 */
function getTaskInitiatorDimensionValue(input: {
  initiatorKind: 'user' | 'automation';
  initiatorUserId: string | null;
  initiatorAutomation: string | null;
  actorExternalId: string | null;
  actorDisplayName: string | null;
  userName: string | null;
  userEmail: string | null;
}) {
  if (input.initiatorKind === 'automation') {
    const key = input.initiatorAutomation ?? PRODUCT_NAME;
    const label = input.initiatorAutomation
      ? formatAutomationLabel(input.initiatorAutomation)
      : PRODUCT_NAME;

    return createDimensionValue(`automation:${key}`, label);
  }

  if (input.initiatorUserId) {
    return getCanonicalUserDimensionValue({
      id: input.initiatorUserId,
      name: input.userName,
      email: input.userEmail,
    });
  }

  const externalLabel =
    input.actorDisplayName ?? input.actorExternalId ?? NO_VALUE_LABEL;

  return createDimensionValue(
    input.actorExternalId
      ? `external:${input.actorExternalId}`
      : `external:${externalLabel}`,
    externalLabel,
  );
}

function formatRepositoryLabel(repositoryName: string) {
  return repositoryName === ALL_REPOSITORIES ? ALL_REPOS_LABEL : repositoryName;
}

function mapTaskSource(surface: TaskSurface | null | undefined) {
  switch (surface) {
    case 'slack':
      return 'Slack';
    case 'teams':
      return 'Teams';
    case 'telegram':
      return 'Telegram';
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'gitea':
      return 'Gitea';
    case 'bitbucket':
      return 'Bitbucket';
    case 'ado':
      return 'Azure DevOps';
    case 'linear':
      return 'Linear';
    case 'web':
      return 'Web';
    case 'api':
      return 'API';
    case 'system':
    default:
      return SYSTEM_SOURCE;
  }
}

type ProjectNameMatch = {
  label: string;
  isPrimary: boolean;
  repoCount: number;
};

function shouldReplaceProjectNameMatch(
  existing: ProjectNameMatch | undefined,
  candidate: ProjectNameMatch,
) {
  if (!existing) {
    return true;
  }

  if (existing.isPrimary !== candidate.isPrimary) {
    return candidate.isPrimary;
  }

  if (existing.repoCount !== candidate.repoCount) {
    return candidate.repoCount < existing.repoCount;
  }

  return false;
}

function buildProjectNameByRepoMap(
  environmentRows: Array<{
    id: string;
    name: string;
    config: typeof environments.$inferSelect.config;
  }>,
) {
  const projectNameByRepo = new Map<string, ProjectNameMatch>();

  for (const environment of environmentRows) {
    const repositories = environment.config?.repositories ?? [];

    for (const [index, repository] of repositories.entries()) {
      const repoKey = repository.repository.toLowerCase();
      const candidate: ProjectNameMatch = {
        label: environment.name,
        isPrimary: index === 0,
        repoCount: repositories.length,
      };

      if (
        shouldReplaceProjectNameMatch(projectNameByRepo.get(repoKey), candidate)
      ) {
        projectNameByRepo.set(repoKey, candidate);
      }
    }
  }

  return new Map(
    [...projectNameByRepo.entries()].map(([repo, match]) => [
      repo,
      match.label,
    ]),
  );
}

function getBucketStart(
  timestamp: Date,
  granularity: AnalyticsGranularity,
): Date {
  switch (granularity) {
    case 'year':
      return startOfYear(timestamp);
    case 'month':
      return startOfMonth(timestamp);
    case 'week':
      return startOfWeek(timestamp, WEEK_OPTIONS);
    case 'day':
    default:
      return startOfDay(timestamp);
  }
}

function formatWeekLabel(bucketStart: Date) {
  const bucketEnd = addDays(bucketStart, 6);
  const startMonth = format(bucketStart, 'MMM');
  const endMonth = format(bucketEnd, 'MMM');

  if (startMonth === endMonth) {
    return `${format(bucketStart, 'MMM d')}–${format(bucketEnd, 'd')}`;
  }

  return `${format(bucketStart, 'MMM d')}–${format(bucketEnd, 'MMM d')}`;
}

function formatBucketLabel(timestamp: Date, granularity: AnalyticsGranularity) {
  switch (granularity) {
    case 'year':
      return format(timestamp, 'yyyy');
    case 'month':
      return format(timestamp, 'MMM yyyy');
    case 'week':
      return formatWeekLabel(timestamp);
    case 'day':
    default:
      return format(timestamp, 'MMM d');
  }
}

function getDimensionSortOrder(dimension: AnalyticsDimension) {
  if (dimension === 'source') {
    return SOURCE_ORDER;
  }

  if (dimension === 'status') {
    return [...PR_STATUS_ORDER];
  }

  return null;
}

function compareDimensionValues(
  dimension: AnalyticsDimension,
  left: string,
  right: string,
) {
  const order = getDimensionSortOrder(dimension);

  if (order) {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    }
  }

  return left.localeCompare(right);
}

function applyDimensionFilters<TRow extends AnalyticsRow>(
  rows: TRow[],
  filters: AnalyticsFilters,
  omitDimension?: AnalyticsDimension,
) {
  return rows.filter((row) => {
    for (const [dimension, values] of Object.entries(filters) as [
      AnalyticsDimension,
      string[],
    ][]) {
      if (!values || values.length === 0 || dimension === omitDimension) {
        continue;
      }

      const dimensionValue = row.dimensions[dimension];

      if (
        dimension === 'taskType' &&
        values.includes('all-automated') &&
        dimensionValue?.key.startsWith('automation:')
      ) {
        continue;
      }

      if (!dimensionValue) {
        return false;
      }

      if (
        !values.includes(dimensionValue.key) &&
        !values.includes(dimensionValue.label)
      ) {
        return false;
      }
    }

    return true;
  });
}

function buildFilterOptions<TRow extends AnalyticsRow>(
  rows: TRow[],
  object: AnalyticsObject,
  filters: AnalyticsFilters,
): AnalyticsFilterOptionsResponse {
  const config = ANALYTICS_OBJECT_CONFIG[object];
  const result: Partial<Record<AnalyticsDimension, AnalyticsFilterOption[]>> =
    {};

  for (const dimension of config.filterDimensions) {
    const options = new Map<string, string>();
    const dimensionRows = applyDimensionFilters(rows, filters, dimension);

    for (const row of dimensionRows) {
      const value = row.dimensions[dimension];
      if (value) {
        options.set(value.key, value.label);
      }
    }

    result[dimension] = [...options.entries()]
      .sort((left, right) =>
        compareDimensionValues(dimension, left[1], right[1]),
      )
      .map(([value, label]) => ({ value, label }));

    if (
      dimension === 'taskType' &&
      result[dimension]?.some((option) =>
        option.value.startsWith('automation:'),
      )
    ) {
      result[dimension] = [
        { value: 'all-automated', label: 'All automated' },
        ...(result[dimension] ?? []),
      ];
    }
  }

  return {
    filters: result,
    availableViewBy: config.viewByDimensions,
  };
}

function resolveAnalyticsMetric(
  object: AnalyticsObject,
  requestedMetric: AnalyticsMetric | undefined,
): AnalyticsMetric {
  if (isValidAnalyticsMetric(object, requestedMetric)) {
    return requestedMetric;
  }

  return getDefaultAnalyticsMetric(object);
}

function buildChartData(
  rows: AnalyticsRow[],
  object: AnalyticsObject,
  requestedViewBy: AnalyticsDimension,
  metric: AnalyticsMetric,
  timePeriod: TimePeriodFilter | undefined,
  granularity: AnalyticsGranularity,
  now: Date,
): AnalyticsChartResponse {
  const viewBy = isValidAnalyticsViewBy(object, requestedViewBy)
    ? requestedViewBy
    : getDefaultAnalyticsViewBy(object);

  const bucketMap = new Map<
    string,
    {
      timestamp: Date;
      label: string;
      total: number;
      segments: Map<string, number>;
    }
  >();
  const seriesTotals = new Map<string, { label: string; total: number }>();
  let firstDataBucketStart: Date | null = null;

  for (const row of rows) {
    const seriesDimension = row.dimensions[viewBy];

    if (!seriesDimension) {
      continue;
    }

    const bucketStart = getBucketStart(row.timestamp, granularity);
    const bucketKey = bucketStart.toISOString();
    const existing = bucketMap.get(bucketKey) ?? {
      timestamp: bucketStart,
      label: formatBucketLabel(bucketStart, granularity),
      total: 0,
      segments: new Map<string, number>(),
    };

    if (!firstDataBucketStart || bucketStart < firstDataBucketStart) {
      firstDataBucketStart = bucketStart;
    }

    existing.total += row.value;
    existing.segments.set(
      seriesDimension.key,
      (existing.segments.get(seriesDimension.key) ?? 0) + row.value,
    );
    bucketMap.set(bucketKey, existing);

    const existingSeries = seriesTotals.get(seriesDimension.key);
    seriesTotals.set(seriesDimension.key, {
      label: seriesDimension.label,
      total: (existingSeries?.total ?? 0) + row.value,
    });
  }

  const series: AnalyticsSeries[] = [...seriesTotals.entries()]
    .filter(([, value]) => value.total > 0)
    .sort((left, right) => {
      const leftLabel = left[1].label;
      const rightLabel = right[1].label;

      if (object === 'pullRequests') {
        return compareDimensionValues(viewBy, leftLabel, rightLabel);
      }

      const totalDiff = right[1].total - left[1].total;
      if (totalDiff !== 0) {
        return totalDiff;
      }

      return compareDimensionValues(viewBy, leftLabel, rightLabel);
    })
    .map(([key, value]) => ({ key, label: value.label, total: value.total }));

  for (const expectedBucket of getExpectedBuckets(
    timePeriod,
    now,
    granularity,
    firstDataBucketStart,
  )) {
    const bucketKey = expectedBucket.toISOString();

    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, {
        timestamp: expectedBucket,
        label: formatBucketLabel(expectedBucket, granularity),
        total: 0,
        segments: new Map<string, number>(),
      });
    }
  }

  const buckets: AnalyticsChartBucket[] = [...bucketMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      total: bucket.total,
      segments: Object.fromEntries(bucket.segments),
    }));

  const response: AnalyticsChartResponse = {
    object,
    viewBy,
    metric,
    series,
    buckets,
    total: rows.reduce((sum, row) => sum + row.value, 0),
  };

  if (object === 'costs') {
    const totalCost = response.total;
    const breakdown = new Map<
      string,
      {
        provider: string;
        model: string;
        cost: number;
        taskCost: number;
        prCost: number;
        tasks: Set<string>;
        prs: Set<string>;
      }
    >();

    for (const row of rows) {
      const provider = row.dimensions.provider?.label ?? 'Unknown provider';
      const model = row.dimensions.model?.label ?? 'Unknown model';
      const key = `${provider}:${model}`;
      const current = breakdown.get(key) ?? {
        provider,
        model,
        cost: 0,
        taskCost: 0,
        prCost: 0,
        tasks: new Set<string>(),
        prs: new Set<string>(),
      };
      current.cost += row.value;
      if (row.meta?.canonicalTaskId) {
        current.tasks.add(row.meta.canonicalTaskId);
        current.taskCost += row.value;
        for (const prKey of row.meta.prKeys ?? []) {
          current.prs.add(prKey);
        }
        if ((row.meta.prKeys ?? []).length > 0) {
          current.prCost += row.value;
        }
      }
      breakdown.set(key, current);
    }

    response.costBreakdown = [...breakdown.entries()]
      .map(
        ([key, row]): AnalyticsCostBreakdownRow => ({
          key,
          provider: row.provider,
          model: row.model,
          totalCost: row.cost,
          costShare: totalCost === 0 ? 0 : (row.cost / totalCost) * 100,
          taskCount: row.tasks.size,
          averageCostPerTask:
            row.tasks.size === 0 ? 0 : row.taskCost / row.tasks.size,
          averageCostPerPr:
            row.prs.size === 0 ? null : row.prCost / row.prs.size,
        }),
      )
      .sort((left, right) => right.totalCost - left.totalCost);

    const taskIds = new Set<string>();
    const qualifyingPrs = new Set<string>();
    let taskCost = 0;
    for (const row of rows) {
      if (!row.meta?.canonicalTaskId) {
        continue;
      }
      taskIds.add(row.meta.canonicalTaskId);
      taskCost += row.value;
      for (const prKey of row.meta.prKeys ?? []) {
        qualifyingPrs.add(prKey);
      }
    }
    const userIds = new Set(
      rows
        .map((row) => row.dimensions.user?.key)
        .filter(
          (user): user is string => Boolean(user) && user !== NO_VALUE_LABEL,
        ),
    );
    const summary: AnalyticsCostSummary = {
      totalInferenceCost: totalCost,
      averageCostPerTask: taskIds.size === 0 ? null : taskCost / taskIds.size,
      averageCostPerPr:
        qualifyingPrs.size === 0 ? null : taskCost / qualifyingPrs.size,
      averageCostPerActiveUser:
        userIds.size === 0 ? null : totalCost / userIds.size,
    };
    response.costSummary = summary;
  }

  return response;
}

function formatPullRequestStatus(status: PullRequestStatus) {
  switch (status) {
    case 'open':
      return 'Open';
    case 'draft':
      return 'Draft';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return status;
  }
}

function getPullRequestKey(repository: string, prNumber: number) {
  return `${repository.toLowerCase()}#${prNumber}`;
}

function formatPullRequestLabel(title: string, prNumber: number) {
  return title.trim() ? title : `#${prNumber}`;
}

function formatGitHubAuthorLabel(
  login: string | null,
  mappedName: string | null | undefined,
) {
  if (!login) {
    return NO_VALUE_LABEL;
  }

  const githubHandle = `@${login}`;

  return mappedName ? `${mappedName} (${githubHandle})` : githubHandle;
}

function getCanonicalGitHubAuthorDimensionValue(params: {
  login: string | null;
  mappedUserId: string | null | undefined;
  mappedName: string | null | undefined;
  isRoomote: boolean;
}) {
  if (params.isRoomote) {
    return createDimensionValue(PRODUCT_NAME, PRODUCT_NAME);
  }

  const normalizedLogin = params.login?.trim().toLowerCase() ?? null;
  const mappedName = params.mappedName?.trim() ?? null;

  if (params.mappedUserId) {
    const label =
      mappedName || (normalizedLogin ? `@${normalizedLogin}` : NO_VALUE_LABEL);

    return createDimensionValue(
      `user:${params.mappedUserId}`,
      label,
      formatGitHubAuthorLabel(normalizedLogin, mappedName),
    );
  }

  if (!normalizedLogin) {
    return createDimensionValue(NO_VALUE_LABEL, NO_VALUE_LABEL);
  }

  return createDimensionValue(
    `github:${normalizedLogin}`,
    `@${normalizedLogin}`,
  );
}

function isAnalyticsRoomoteGitHubLogin(login: string | null) {
  if (!login) {
    return false;
  }

  const normalizedLogin = login.trim().toLowerCase();

  return GitHub.Schemas.isRoomoteGitHubLogin(normalizedLogin);
}

function isRoomotePullRequestAuthor(login: string | null) {
  return isAnalyticsRoomoteGitHubLogin(login);
}

async function getRoomotePullRequestMetadataByKey(_auth: UserAuthSuccess) {
  // isRoomotePullRequestAuthor classifies logins synchronously from the
  // cached configured app slug.
  await GitHub.resolveConfiguredGitHubAppSlug();

  const results = await db
    .select({
      taskId: taskPullRequests.taskId,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      detectedAt: taskPullRequests.detectedAt,
      updatedAt: taskPullRequests.updatedAt,
      taskInitiatorKind: tasks.initiatorKind,
      taskInitiatorUserId: tasks.initiatorUserId,
      taskInitiatorAutomation: tasks.initiatorAutomation,
      taskActorExternalId: tasks.actorExternalId,
      taskActorDisplayName: tasks.actorDisplayName,
      taskUserName: taskInitiatorUsers.name,
      taskUserEmail: taskInitiatorUsers.email,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .leftJoin(
      taskInitiatorUsers,
      eq(taskInitiatorUsers.id, tasks.initiatorUserId),
    );

  const deduped = new Map<
    string,
    {
      canonicalTaskId: string;
      detectedAt: Date;
      updatedAt: Date;
      userDimension: AnalyticsDimensionValue;
    }
  >();

  for (const result of results) {
    if (!result.repository || result.prNumber === null) {
      continue;
    }

    const dedupeKey = getPullRequestKey(result.repository, result.prNumber);
    const existing = deduped.get(dedupeKey);

    if (
      !existing ||
      result.detectedAt < existing.detectedAt ||
      (result.detectedAt.getTime() === existing.detectedAt.getTime() &&
        result.updatedAt < existing.updatedAt)
    ) {
      deduped.set(dedupeKey, {
        canonicalTaskId: result.taskId,
        detectedAt: result.detectedAt,
        updatedAt: result.updatedAt,
        userDimension: getTaskInitiatorDimensionValue({
          initiatorKind: result.taskInitiatorKind,
          initiatorUserId: result.taskInitiatorUserId,
          initiatorAutomation: result.taskInitiatorAutomation,
          actorExternalId: result.taskActorExternalId,
          actorDisplayName: result.taskActorDisplayName,
          userName: result.taskUserName,
          userEmail: result.taskUserEmail,
        }),
      });
    }
  }

  return deduped;
}

async function getGitHubUserByLogin(logins: string[]) {
  if (logins.length === 0) {
    return new Map<
      string,
      { userId: string | null; userName: string | null }
    >();
  }

  const mappings = await db
    .select({
      githubLogin: githubUserMappings.githubLogin,
      userId: users.id,
      userName: users.name,
      updatedAt: githubUserMappings.updatedAt,
    })
    .from(githubUserMappings)
    .leftJoin(users, eq(users.id, githubUserMappings.userId))
    .where(inArray(githubUserMappings.githubLogin, logins));

  const latestByLogin = new Map<
    string,
    { userId: string | null; userName: string | null; updatedAt: Date }
  >();

  for (const mapping of mappings) {
    const existing = latestByLogin.get(mapping.githubLogin);

    if (!existing || mapping.updatedAt > existing.updatedAt) {
      latestByLogin.set(mapping.githubLogin, {
        userId: mapping.userId,
        userName: mapping.userName,
        updatedAt: mapping.updatedAt,
      });
    }
  }

  return new Map(
    [...latestByLogin.entries()].map(([login, value]) => [
      login,
      {
        userId: value.userId,
        userName: value.userName,
      },
    ]),
  );
}

function resolveDimensionLabelCollisions<TRow extends AnalyticsRow>(
  rows: TRow[],
) {
  const labelsByDimension = new Map<
    AnalyticsDimension,
    Map<string, Set<string>>
  >();

  for (const row of rows) {
    for (const [dimension, value] of Object.entries(row.dimensions) as [
      AnalyticsDimension,
      AnalyticsDimensionValue,
    ][]) {
      const labelsForDimension =
        labelsByDimension.get(dimension) ?? new Map<string, Set<string>>();
      const keysForLabel =
        labelsForDimension.get(value.label) ?? new Set<string>();
      keysForLabel.add(value.key);
      labelsForDimension.set(value.label, keysForLabel);
      labelsByDimension.set(dimension, labelsForDimension);
    }
  }

  for (const row of rows) {
    for (const [dimension, value] of Object.entries(row.dimensions) as [
      AnalyticsDimension,
      AnalyticsDimensionValue,
    ][]) {
      const collidingKeys = labelsByDimension.get(dimension)?.get(value.label);

      if (
        collidingKeys &&
        collidingKeys.size > 1 &&
        value.disambiguationLabel
      ) {
        value.label = value.disambiguationLabel;
      }
    }
  }

  return rows;
}

function buildPullRequestAnalyticsSummary(
  rows: PullRequestAnalyticsRow[],
  timePeriod: TimePeriodFilter | undefined,
  granularity: AnalyticsGranularity,
  now: Date,
): PullRequestAnalyticsSummary {
  const totalPullRequests = rows.length;
  const roomotePullRequests = rows.filter((row) => row.meta.isRoomote);
  const mergedRoomotePullRequests = roomotePullRequests.filter(
    (row) => row.meta.isMerged,
  );
  const uniqueAuthors = new Set(
    rows
      .map((row) => row.dimensions.author?.key)
      .filter((authorKey): authorKey is string => Boolean(authorKey)),
  );
  const pullRequestsPerAuthor =
    uniqueAuthors.size === 0 ? null : totalPullRequests / uniqueAuthors.size;
  const periodCount = getSummaryPeriodCount(rows, timePeriod, granularity, now);

  return {
    totalPullRequests,
    roomotePullRequests: {
      total: roomotePullRequests.length,
      percentage:
        totalPullRequests === 0
          ? 0
          : (roomotePullRequests.length / totalPullRequests) * 100,
    },
    mergedRoomotePullRequests: {
      total: mergedRoomotePullRequests.length,
      percentage:
        roomotePullRequests.length === 0
          ? 0
          : (mergedRoomotePullRequests.length / roomotePullRequests.length) *
            100,
    },
    authorCount: uniqueAuthors.size,
    pullRequestsPerAuthor,
    pullRequestsPerAuthorPerPeriod:
      pullRequestsPerAuthor === null || periodCount === 0
        ? null
        : pullRequestsPerAuthor / periodCount,
  };
}

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

async function getTaskAnalyticsRows(
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

function getTaskTypeDimensionValue(task: {
  initiatorKind: 'user' | 'automation' | null;
  initiatorAutomation: string | null;
}) {
  if (!task.initiatorKind) {
    return createLabelBackedDimensionValue('Unknown');
  }

  if (task.initiatorKind === 'automation') {
    const key = task.initiatorAutomation ?? 'unknown';
    return createDimensionValue(
      `automation:${key}`,
      task.initiatorAutomation
        ? formatAutomationLabel(task.initiatorAutomation)
        : 'Unknown',
    );
  }

  return createLabelBackedDimensionValue('Manual');
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

async function getCostAnalyticsRows(
  _auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<AnalyticsRow[]> {
  const cutoff = getTimeCutoff(timePeriod, now);
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
    .where(isNull(tasks.deletedAt));

  const environmentRows = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(eq(environments.isEval, false));
  const environmentNameById = new Map(
    environmentRows.map((environment) => [environment.id, environment.name]),
  );
  const taskIds = usageRows
    .map((row) => row.taskId)
    .filter((taskId): taskId is string => Boolean(taskId));
  const pullRequestRows =
    taskIds.length === 0
      ? []
      : await db
          .select({
            taskId: taskPullRequests.taskId,
            repository: taskPullRequests.repository,
            prNumber: taskPullRequests.prNumber,
          })
          .from(taskPullRequests)
          .where(inArray(taskPullRequests.taskId, taskIds));
  const prKeysByTaskId = new Map<string, Set<string>>();
  for (const pullRequest of pullRequestRows) {
    if (pullRequest.prNumber === null || !pullRequest.repository) {
      continue;
    }

    const keys = prKeysByTaskId.get(pullRequest.taskId) ?? new Set<string>();
    keys.add(getPullRequestKey(pullRequest.repository, pullRequest.prNumber));
    prKeysByTaskId.set(pullRequest.taskId, keys);
  }

  return usageRows
    .filter((row) => {
      const timestamp = row.timestamp ?? row.createdAt;
      return !cutoff || timestamp >= cutoff;
    })
    .map((row) => {
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

async function getPullRequestAnalyticsRows(
  auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<PullRequestAnalyticsRow[]> {
  const repositories = await getRepositories(auth);

  if (repositories.length === 0) {
    return [];
  }

  const repositoryIds = repositories.map((repository) => repository.id);
  const repositoryIdsNeedingBackfill =
    await getPullRequestFactRepositoryIdsNeedingBackfill({
      repositoryIds,
    });
  const requestTimeBootstrapCutoff = getRequestTimeBootstrapCutoff(
    timePeriod,
    now,
  );

  if (requestTimeBootstrapCutoff && repositoryIdsNeedingBackfill.length > 0) {
    try {
      await syncGitHubPullRequestFactsForOrg({
        actorUserId: auth.userId,
        bootstrapCreatedAfter: requestTimeBootstrapCutoff,
        repositoryIds: repositoryIdsNeedingBackfill,
        now,
      });
    } catch (error) {
      console.warn(
        `[analytics] Failed to bootstrap PR fact cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const [livePullRequests, roomoteMetadataByKey] = await Promise.all([
    getStoredPullRequestsForAnalytics({
      repositoryIds,
      timePeriod,
      now,
    }),
    getRoomotePullRequestMetadataByKey(auth),
  ]);

  const githubUserByLogin = await getGitHubUserByLogin(
    [...new Set(livePullRequests.map((pullRequest) => pullRequest.authorLogin))]
      .filter((login): login is string => Boolean(login))
      .sort((left, right) => left.localeCompare(right)),
  );

  return resolveDimensionLabelCollisions(
    livePullRequests.map((pullRequest) => {
      const roomoteMetadata = roomoteMetadataByKey.get(
        getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
      );
      const isRoomote =
        Boolean(roomoteMetadata) ||
        isRoomotePullRequestAuthor(pullRequest.authorLogin);
      const timestamp = new Date(pullRequest.createdAt);
      const mappedAuthor = pullRequest.authorLogin
        ? githubUserByLogin.get(pullRequest.authorLogin)
        : null;
      const mappedAuthorName = mappedAuthor?.userName ?? null;
      const authorLabel = formatGitHubAuthorLabel(
        pullRequest.authorLogin,
        mappedAuthorName,
      );
      const canonicalAuthorDimension = getCanonicalGitHubAuthorDimensionValue({
        login: pullRequest.authorLogin,
        mappedUserId: mappedAuthor?.userId,
        mappedName: mappedAuthorName,
        isRoomote,
      });
      const userLabel = roomoteMetadata?.userDimension.label ?? authorLabel;
      const canonicalUserDimension =
        roomoteMetadata?.userDimension ?? canonicalAuthorDimension;
      const statusLabel = formatPullRequestStatus(pullRequest.state);
      const repoLabel = pullRequest.repoFullName
        ? formatRepositoryLabel(pullRequest.repoFullName)
        : UNKNOWN_REPO_LABEL;
      const prLabel = formatPullRequestLabel(
        pullRequest.title,
        pullRequest.number,
      );
      const taskLink = roomoteMetadata
        ? `/task/${roomoteMetadata.canonicalTaskId}`
        : undefined;

      return {
        id: getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
        timestamp,
        value: 1,
        dimensions: {
          user: canonicalUserDimension,
          author: canonicalAuthorDimension,
          status: createLabelBackedDimensionValue(statusLabel),
          repo: createLabelBackedDimensionValue(repoLabel),
        },
        details: {
          id: getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
          values: {
            date: formatAnalyticsDateTime(timestamp),
            user: userLabel,
            author: authorLabel,
            repo: repoLabel,
            pr: prLabel,
            status: statusLabel,
            createdBy: isRoomote
              ? ROOMOTE_CREATED_BY_LABEL
              : HUMAN_CREATED_BY_LABEL,
            task: roomoteMetadata ? 'View task' : NO_VALUE_LABEL,
          },
          links: {
            pr: pullRequest.url,
            ...(taskLink ? { task: taskLink } : {}),
          },
        },
        meta: {
          authorLogin: pullRequest.authorLogin,
          canonicalTaskId: roomoteMetadata?.canonicalTaskId ?? null,
          isMerged: pullRequest.state === 'merged',
          isRoomote,
        },
      } satisfies PullRequestAnalyticsRow;
    }),
  );
}

async function getAnalyticsRows(
  auth: UserAuthSuccess,
  object: AnalyticsObject,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
  metric: AnalyticsMetric = getDefaultAnalyticsMetric(object),
) {
  switch (object) {
    case 'tasks':
      return getTaskAnalyticsRows(auth, timePeriod, now, metric);
    case 'pullRequests':
      return getPullRequestAnalyticsRows(auth, timePeriod, now);
    case 'costs':
      return getCostAnalyticsRows(auth, timePeriod, now);
  }
}

function getAnalyticsDetailsColumns(
  object: AnalyticsObject,
  metric: AnalyticsMetric = getDefaultAnalyticsMetric(object),
): AnalyticsDetailsColumn[] {
  switch (object) {
    case 'tasks': {
      const columns: AnalyticsDetailsColumn[] = [
        { key: 'date', label: 'Date' },
        { key: 'user', label: 'User' },
        { key: 'project', label: 'Environment' },
        { key: 'source', label: 'Source' },
        { key: 'taskType', label: 'Task Type' },
        { key: 'taskTitle', label: 'Task Title' },
        { key: 'task', label: 'Task Link' },
      ];

      if (metric === 'tokens') {
        columns.splice(5, 0, { key: 'tokens', label: 'Tokens' });
      } else if (metric === 'cost') {
        columns.splice(5, 0, { key: 'cost', label: 'Cost (USD)' });
      }

      return columns;
    }
    case 'pullRequests':
      return [
        { key: 'date', label: 'Date' },
        { key: 'user', label: 'User' },
        { key: 'author', label: 'Author' },
        { key: 'repo', label: 'Repo' },
        { key: 'pr', label: 'PR' },
        { key: 'status', label: 'Status' },
        { key: 'createdBy', label: 'Created By' },
        { key: 'task', label: 'Task Link' },
      ];
    case 'costs':
      return [
        { key: 'date', label: 'Date' },
        { key: 'user', label: 'User' },
        { key: 'taskType', label: 'Task Type' },
        { key: 'project', label: 'Environment' },
        { key: 'provider', label: 'Provider' },
        { key: 'model', label: 'Model' },
        { key: 'cost', label: 'Cost (USD)' },
        { key: 'taskTitle', label: 'Task' },
      ];
  }
}

export async function getAnalyticsChartData(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
  now: Date = new Date(),
): Promise<AnalyticsChartResponse> {
  const metric = resolveAnalyticsMetric(input.object, input.metric);
  const rows = await getAnalyticsRows(
    auth,
    input.object,
    input.timePeriod,
    now,
    metric,
  );
  const filteredRows = applyDimensionFilters(rows, input.filters ?? {});
  const granularity = getResolvedGranularity(
    input.timePeriod,
    input.granularity,
  );

  return buildChartData(
    filteredRows,
    input.object,
    input.viewBy,
    metric,
    input.timePeriod,
    granularity,
    now,
  );
}

export async function getPullRequestAnalyticsOverview(
  auth: UserAuthSuccess,
  input: {
    viewBy: AnalyticsDimension;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
  now: Date = new Date(),
): Promise<PullRequestAnalyticsOverviewResponse> {
  const rows = await getPullRequestAnalyticsRows(auth, input.timePeriod, now);
  const filteredRows = applyDimensionFilters(rows, input.filters ?? {});
  const granularity = getResolvedGranularity(
    input.timePeriod,
    input.granularity,
  );
  const metric = getDefaultAnalyticsMetric('pullRequests');

  return {
    chart: buildChartData(
      filteredRows,
      'pullRequests',
      input.viewBy,
      metric,
      input.timePeriod,
      granularity,
      now,
    ),
    filterOptions: buildFilterOptions(
      rows,
      'pullRequests',
      input.filters ?? {},
    ),
    summary: buildPullRequestAnalyticsSummary(
      filteredRows,
      input.timePeriod,
      granularity,
      now,
    ),
  };
}

export async function getAnalyticsFilterOptions(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
  },
  now: Date = new Date(),
): Promise<AnalyticsFilterOptionsResponse> {
  const rows = await getAnalyticsRows(
    auth,
    input.object,
    input.timePeriod,
    now,
  );
  return buildFilterOptions(rows, input.object, input.filters ?? {});
}

export async function getAnalyticsExportData(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
  now: Date = new Date(),
): Promise<AnalyticsExportResponse> {
  const metric = resolveAnalyticsMetric(input.object, input.metric);
  const rows = await getAnalyticsRows(
    auth,
    input.object,
    input.timePeriod,
    now,
    metric,
  );
  const filteredRows = applyDimensionFilters(rows, input.filters ?? {});
  const viewBy = isValidAnalyticsViewBy(input.object, input.viewBy)
    ? input.viewBy
    : getDefaultAnalyticsViewBy(input.object);
  const sortedRows = filteredRows.sort(
    (left, right) => right.timestamp.getTime() - left.timestamp.getTime(),
  );

  return {
    object: input.object,
    viewBy,
    columns: getAnalyticsDetailsColumns(input.object, metric),
    rows: sortedRows.map((row) => row.details),
    total: sortedRows.reduce((sum, row) => sum + row.value, 0),
  };
}

export async function getAnalyticsDetails(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
    bucketKey: string;
    seriesKey: string;
  },
  now: Date = new Date(),
): Promise<AnalyticsDetailsResponse> {
  const metric = resolveAnalyticsMetric(input.object, input.metric);
  const rows = await getAnalyticsRows(
    auth,
    input.object,
    input.timePeriod,
    now,
    metric,
  );
  const filteredRows = applyDimensionFilters(rows, input.filters ?? {});
  const viewBy = isValidAnalyticsViewBy(input.object, input.viewBy)
    ? input.viewBy
    : getDefaultAnalyticsViewBy(input.object);
  const granularity = getResolvedGranularity(
    input.timePeriod,
    input.granularity,
  );

  const matchingRows = filteredRows
    .filter(
      (row) =>
        (row.dimensions[viewBy]?.key === input.seriesKey ||
          row.dimensions[viewBy]?.label === input.seriesKey) &&
        getBucketStart(row.timestamp, granularity).toISOString() ===
          input.bucketKey,
    )
    .sort(
      (left, right) => right.timestamp.getTime() - left.timestamp.getTime(),
    );

  return {
    object: input.object,
    bucketKey: input.bucketKey,
    seriesKey: input.seriesKey,
    columns: getAnalyticsDetailsColumns(input.object, metric),
    rows: matchingRows.map((row) => row.details),
    total: matchingRows.reduce((sum, row) => sum + row.value, 0),
  };
}
