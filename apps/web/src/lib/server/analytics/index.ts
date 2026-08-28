import {
  type AnalyticsChartResponse,
  type AnalyticsDetailsColumn,
  type AnalyticsDetailsResponse,
  type AnalyticsDimension,
  type AnalyticsExportResponse,
  type AnalyticsFilterOptionsResponse,
  type AnalyticsFilters,
  type AnalyticsGranularity,
  type AnalyticsMetric,
  type AnalyticsObject,
  type AnalyticsOverviewResponse,
  type PullRequestAnalyticsOverviewResponse,
  type TimePeriodFilter,
  getDefaultAnalyticsMetric,
  getDefaultAnalyticsViewBy,
  isValidAnalyticsViewBy,
} from '@/types';
import type { UserAuthSuccess } from '@/types';

import {
  aggregateCostAnalyticsRowsByTask,
  getCostAnalyticsRows,
} from './cost-rows';
import { getTaskAnalyticsRows } from './task-rows';
import {
  buildPullRequestAnalyticsSummary,
  getPullRequestAnalyticsRows,
} from './pull-request-rows';
import { buildChartData, resolveAnalyticsMetric } from './chart';
import { applyDimensionFilters, buildFilterOptions } from './dimensions';
import { getBucketStart, getResolvedGranularity } from './time-buckets';

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
        { key: 'taskType', label: 'Type' },
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
        { key: 'taskType', label: 'Type' },
        { key: 'project', label: 'Environment' },
        { key: 'source', label: 'Source' },
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

export async function getAnalyticsOverview(
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
): Promise<AnalyticsOverviewResponse> {
  const metric = resolveAnalyticsMetric(input.object, input.metric);
  const rows = await getAnalyticsRows(
    auth,
    input.object,
    input.timePeriod,
    now,
    metric,
  );
  const filters = input.filters ?? {};
  const filteredRows = applyDimensionFilters(rows, filters);
  const granularity = getResolvedGranularity(
    input.timePeriod,
    input.granularity,
  );

  return {
    chart: buildChartData(
      filteredRows,
      input.object,
      input.viewBy,
      metric,
      input.timePeriod,
      granularity,
      now,
    ),
    filterOptions: buildFilterOptions(rows, input.object, filters),
  };
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

  let matchingRows = filteredRows
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

  if (input.object === 'costs') {
    matchingRows = aggregateCostAnalyticsRowsByTask(matchingRows);
  }

  return {
    object: input.object,
    bucketKey: input.bucketKey,
    seriesKey: input.seriesKey,
    columns: getAnalyticsDetailsColumns(input.object, metric),
    rows: matchingRows.map((row) => row.details),
    total: matchingRows.reduce((sum, row) => sum + row.value, 0),
  };
}
