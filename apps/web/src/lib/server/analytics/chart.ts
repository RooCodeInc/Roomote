import {
  type AnalyticsChartBucket,
  type AnalyticsChartResponse,
  type AnalyticsDimension,
  type AnalyticsGranularity,
  type AnalyticsMetric,
  type AnalyticsObject,
  type AnalyticsSeries,
  type TimePeriodFilter,
  getDefaultAnalyticsMetric,
  getDefaultAnalyticsViewBy,
  isValidAnalyticsMetric,
  isValidAnalyticsViewBy,
} from '@/types';

import { type AnalyticsRow } from './types';
import { buildCostChartAnalytics } from './cost-summary';
import {
  formatBucketLabel,
  getBucketStart,
  getExpectedBuckets,
} from './time-buckets';
import { compareDimensionValues } from './dimensions';

export function resolveAnalyticsMetric(
  object: AnalyticsObject,
  requestedMetric: AnalyticsMetric | undefined,
): AnalyticsMetric {
  if (isValidAnalyticsMetric(object, requestedMetric)) {
    return requestedMetric;
  }

  return getDefaultAnalyticsMetric(object);
}

export function buildChartData(
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
    const costAnalytics = buildCostChartAnalytics(rows);
    response.costBreakdown = costAnalytics.costBreakdown;
    response.costSummary = costAnalytics.costSummary;
  }

  return response;
}
