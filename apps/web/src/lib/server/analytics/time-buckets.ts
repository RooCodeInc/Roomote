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

import {
  type AnalyticsGranularity,
  type TimePeriodFilter,
  getDefaultAnalyticsGranularity,
  isValidAnalyticsGranularity,
} from '@/types';

import {
  DAYS_PER_MONTH,
  DAYS_PER_WEEK,
  DAYS_PER_YEAR,
  WEEK_OPTIONS,
  type PullRequestAnalyticsRow,
} from './types';

export function formatAnalyticsDateTime(timestamp: Date) {
  return format(timestamp, 'MMM d, yyyy h:mm a');
}

export function getRequestTimeBootstrapCutoff(
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

export function getResolvedGranularity(
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

export function getTimeCutoff(
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Date | null {
  if (!timePeriod || timePeriod === 'all') {
    return null;
  }

  return startOfDay(subDays(now, timePeriod - 1));
}

export function getExpectedBuckets(
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

export function getSummaryPeriodCount(
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
export function getBucketStart(
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

export function formatBucketLabel(
  timestamp: Date,
  granularity: AnalyticsGranularity,
) {
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
