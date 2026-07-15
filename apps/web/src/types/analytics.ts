import { z } from 'zod';

import { timePeriodFilterSchema, type TimePeriodFilter } from './time-period';

export const analyticsObjects = ['tasks', 'pullRequests', 'costs'] as const;
export const analyticsObjectSchema = z.enum(analyticsObjects);
export type AnalyticsObject = z.infer<typeof analyticsObjectSchema>;

/** Y-axis metric for the Tasks analytics chart. PR analytics is always count. */
const analyticsMetrics = ['tasks', 'tokens', 'cost'] as const;
export const analyticsMetricSchema = z.enum(analyticsMetrics);
export type AnalyticsMetric = z.infer<typeof analyticsMetricSchema>;

const analyticsDimensions = [
  'user',
  'project',
  'source',
  'status',
  'repo',
  'author',
  'taskType',
  'provider',
  'model',
] as const;
export const analyticsDimensionSchema = z.enum(analyticsDimensions);
export type AnalyticsDimension = z.infer<typeof analyticsDimensionSchema>;

const analyticsGranularities = ['day', 'week', 'month', 'year'] as const;
export const analyticsGranularitySchema = z.enum(analyticsGranularities);
export type AnalyticsGranularity = z.infer<typeof analyticsGranularitySchema>;

const analyticsFilterValueSchema = z.array(z.string()).optional();

export const analyticsFiltersSchema = z
  .object({
    user: analyticsFilterValueSchema,
    project: analyticsFilterValueSchema,
    source: analyticsFilterValueSchema,
    status: analyticsFilterValueSchema,
    repo: analyticsFilterValueSchema,
    author: analyticsFilterValueSchema,
    taskType: analyticsFilterValueSchema,
    provider: analyticsFilterValueSchema,
    model: analyticsFilterValueSchema,
  })
  .partial();
export type AnalyticsFilters = z.infer<typeof analyticsFiltersSchema>;

export const analyticsChartInputSchema = z.object({
  object: analyticsObjectSchema,
  viewBy: analyticsDimensionSchema,
  metric: analyticsMetricSchema.optional(),
  filters: analyticsFiltersSchema.optional(),
  timePeriod: timePeriodFilterSchema.optional(),
  granularity: analyticsGranularitySchema.optional(),
});

export const analyticsFilterOptionsInputSchema = z.object({
  object: analyticsObjectSchema,
  filters: analyticsFiltersSchema.optional(),
  timePeriod: timePeriodFilterSchema.optional(),
});

export const analyticsDetailsInputSchema = z.object({
  object: analyticsObjectSchema,
  viewBy: analyticsDimensionSchema,
  metric: analyticsMetricSchema.optional(),
  filters: analyticsFiltersSchema.optional(),
  timePeriod: timePeriodFilterSchema.optional(),
  granularity: analyticsGranularitySchema.optional(),
  bucketKey: z.string(),
  seriesKey: z.string(),
});

export const analyticsExportInputSchema = z.object({
  object: analyticsObjectSchema,
  viewBy: analyticsDimensionSchema,
  metric: analyticsMetricSchema.optional(),
  filters: analyticsFiltersSchema.optional(),
  timePeriod: timePeriodFilterSchema.optional(),
  granularity: analyticsGranularitySchema.optional(),
});

export const pullRequestAnalyticsOverviewInputSchema = z.object({
  viewBy: analyticsDimensionSchema,
  filters: analyticsFiltersSchema.optional(),
  timePeriod: timePeriodFilterSchema.optional(),
  granularity: analyticsGranularitySchema.optional(),
});

export type AnalyticsFilterOption = {
  value: string;
  label: string;
};

export type AnalyticsSeries = {
  key: string;
  label: string;
  total: number;
};

export type AnalyticsChartBucket = {
  key: string;
  label: string;
  total: number;
  segments: Record<string, number>;
};

export type AnalyticsChartResponse = {
  object: AnalyticsObject;
  viewBy: AnalyticsDimension;
  metric: AnalyticsMetric;
  series: AnalyticsSeries[];
  buckets: AnalyticsChartBucket[];
  total: number;
  costBreakdown?: AnalyticsCostBreakdownRow[];
  costSummary?: AnalyticsCostSummary;
};

export type AnalyticsCostSummary = {
  totalInferenceCost: number;
  averageCostPerTask: number | null;
  averageCostPerPr: number | null;
  averageCostPerActiveUser: number | null;
  taskCount: number;
  prCount: number;
  activeUserCount: number;
};

export type AnalyticsCostBreakdownRow = {
  key: string;
  provider: string;
  model: string;
  totalCost: number;
  costShare: number;
  taskCount: number;
  averageCostPerTask: number;
  averageCostPerPr: number | null;
};

export type AnalyticsFilterOptionsResponse = {
  filters: Partial<Record<AnalyticsDimension, AnalyticsFilterOption[]>>;
  availableViewBy: AnalyticsDimension[];
};

export type AnalyticsDetailsColumn = {
  key: string;
  label: string;
};

export type AnalyticsDetailsRow = {
  id: string;
  values: Record<string, string>;
  links?: Partial<Record<string, string>>;
};

export type AnalyticsDetailsResponse = {
  object: AnalyticsObject;
  bucketKey: string;
  seriesKey: string;
  columns: AnalyticsDetailsColumn[];
  rows: AnalyticsDetailsRow[];
  total: number;
};

export type AnalyticsExportResponse = {
  object: AnalyticsObject;
  viewBy: AnalyticsDimension;
  columns: AnalyticsDetailsColumn[];
  rows: AnalyticsDetailsRow[];
  total: number;
};

export type PullRequestAnalyticsSummary = {
  totalPullRequests: number;
  roomotePullRequests: {
    total: number;
    percentage: number;
  };
  mergedRoomotePullRequests: {
    total: number;
    percentage: number;
  };
  authorCount: number;
  pullRequestsPerAuthor: number | null;
  pullRequestsPerAuthorPerPeriod: number | null;
};

export type PullRequestAnalyticsOverviewResponse = {
  chart: AnalyticsChartResponse;
  filterOptions: AnalyticsFilterOptionsResponse;
  summary: PullRequestAnalyticsSummary;
};

export const ANALYTICS_OBJECT_CONFIG = {
  tasks: {
    label: 'Tasks',
    axisLabel: 'Tasks',
    filterDimensions: [
      'user',
      'project',
      'source',
      'taskType',
    ] as AnalyticsDimension[],
    viewByDimensions: [
      'user',
      'project',
      'source',
      'taskType',
    ] as AnalyticsDimension[],
    defaultViewBy: 'user' as AnalyticsDimension,
    supportedMetrics: ['tasks'] as readonly AnalyticsMetric[],
    defaultMetric: 'tasks' as AnalyticsMetric,
  },
  pullRequests: {
    label: 'PRs',
    axisLabel: 'PRs',
    filterDimensions: [
      'user',
      'status',
      'repo',
      'author',
    ] as AnalyticsDimension[],
    viewByDimensions: [
      'user',
      'status',
      'repo',
      'author',
    ] as AnalyticsDimension[],
    defaultViewBy: 'user' as AnalyticsDimension,
    supportedMetrics: ['tasks'] as readonly AnalyticsMetric[],
    defaultMetric: 'tasks' as AnalyticsMetric,
  },
  costs: {
    label: 'Costs',
    axisLabel: 'Cost (USD)',
    filterDimensions: [
      'user',
      'taskType',
      'project',
      'provider',
      'model',
    ] as AnalyticsDimension[],
    viewByDimensions: [
      'user',
      'taskType',
      'project',
      'provider',
      'model',
    ] as AnalyticsDimension[],
    defaultViewBy: 'taskType' as AnalyticsDimension,
    supportedMetrics: ['cost'] as readonly AnalyticsMetric[],
    defaultMetric: 'cost' as AnalyticsMetric,
  },
} as const satisfies Record<
  AnalyticsObject,
  {
    label: string;
    axisLabel: string;
    filterDimensions: AnalyticsDimension[];
    viewByDimensions: AnalyticsDimension[];
    defaultViewBy: AnalyticsDimension;
    supportedMetrics: readonly AnalyticsMetric[];
    defaultMetric: AnalyticsMetric;
  }
>;

export const ANALYTICS_DIMENSION_LABELS: Record<AnalyticsDimension, string> = {
  user: 'User',
  project: 'Environment',
  source: 'Source',
  status: 'Status',
  repo: 'Repo',
  author: 'Author',
  taskType: 'Task Type',
  provider: 'Provider',
  model: 'Model',
};

export const ANALYTICS_METRIC_LABELS: Record<AnalyticsMetric, string> = {
  tasks: 'Tasks',
  tokens: 'Tokens',
  cost: 'Cost',
};

const ANALYTICS_METRIC_AXIS_LABELS: Record<AnalyticsMetric, string> = {
  tasks: 'Tasks',
  tokens: 'Tokens',
  cost: 'Cost (USD)',
};

export const ANALYTICS_GRANULARITY_LABELS: Record<
  AnalyticsGranularity,
  string
> = {
  day: 'By Day',
  week: 'By Week',
  month: 'By Month',
  year: 'By Year',
};

export const ANALYTICS_TIME_RANGE_OPTIONS = [
  { value: 1, label: 'Today' },
  { value: 7, label: 'Last 7 Days' },
  { value: 30, label: 'Last 30 Days' },
  { value: 90, label: 'Last 90 Days' },
  { value: 'all', label: 'All Time' },
] as const satisfies ReadonlyArray<{
  value: TimePeriodFilter;
  label: string;
}>;

export function getDefaultAnalyticsViewBy(
  object: AnalyticsObject,
): AnalyticsDimension {
  return ANALYTICS_OBJECT_CONFIG[object].defaultViewBy;
}

export function isValidAnalyticsViewBy(
  object: AnalyticsObject,
  viewBy: string | null | undefined,
): viewBy is AnalyticsDimension {
  if (!viewBy) {
    return false;
  }

  return ANALYTICS_OBJECT_CONFIG[object].viewByDimensions.includes(
    viewBy as AnalyticsDimension,
  );
}

export function getDefaultAnalyticsMetric(
  object: AnalyticsObject,
): AnalyticsMetric {
  return ANALYTICS_OBJECT_CONFIG[object].defaultMetric;
}

export function isValidAnalyticsMetric(
  object: AnalyticsObject,
  metric: string | null | undefined,
): metric is AnalyticsMetric {
  if (!metric) {
    return false;
  }

  return ANALYTICS_OBJECT_CONFIG[object].supportedMetrics.includes(
    metric as AnalyticsMetric,
  );
}

export function getAnalyticsAxisLabel(
  object: AnalyticsObject,
  metric: AnalyticsMetric = getDefaultAnalyticsMetric(object),
): string {
  if (object === 'pullRequests') {
    return ANALYTICS_OBJECT_CONFIG.pullRequests.axisLabel;
  }

  return ANALYTICS_METRIC_AXIS_LABELS[metric];
}

export function getAvailableAnalyticsGranularities(
  _timePeriod: TimePeriodFilter,
): AnalyticsGranularity[] {
  return ['day', 'week', 'month', 'year'];
}

export function getDefaultAnalyticsGranularity(
  timePeriod: TimePeriodFilter,
): AnalyticsGranularity {
  if (timePeriod === 'all') {
    return 'month';
  }

  return getAvailableAnalyticsGranularities(timePeriod)[0]!;
}

export function isValidAnalyticsGranularity(
  timePeriod: TimePeriodFilter,
  granularity: string | null | undefined,
): granularity is AnalyticsGranularity {
  if (!granularity) {
    return false;
  }

  return getAvailableAnalyticsGranularities(timePeriod).includes(
    granularity as AnalyticsGranularity,
  );
}
