'use client';

import type {
  AnalyticsDimension,
  AnalyticsGranularity,
  AnalyticsMetric,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';
import { ANALYTICS_TIME_RANGE_OPTIONS } from '@/types';

import {
  AnalyticsSelectField,
  toTimeRangeSelectValue,
} from './AnalyticsSelectField';
import { AnalyticsGroupBy } from './AnalyticsGroupBy';
import { AnalyticsGranularitySelector } from './AnalyticsGranularitySelector';
import { AnalyticsMetricSelector } from './AnalyticsMetricSelector';

type AnalyticsControlRowProps = {
  object: AnalyticsObject;
  viewBy: AnalyticsDimension;
  metric: AnalyticsMetric;
  timePeriod: TimePeriodFilter;
  granularity: AnalyticsGranularity;
  availableGranularities: AnalyticsGranularity[];
  onViewByChange: (value: AnalyticsDimension) => void;
  onMetricChange: (value: AnalyticsMetric) => void;
  onTimePeriodChange: (value: TimePeriodFilter) => void;
  onGranularityChange: (value: AnalyticsGranularity) => void;
};

export function AnalyticsControlRow({
  object,
  viewBy,
  metric,
  timePeriod,
  granularity,
  availableGranularities,
  onViewByChange,
  onMetricChange,
  onTimePeriodChange,
  onGranularityChange,
}: AnalyticsControlRowProps) {
  return (
    <>
      <AnalyticsMetricSelector
        object={object}
        value={metric}
        onChange={onMetricChange}
      />
      <AnalyticsGroupBy
        object={object}
        value={viewBy}
        onChange={onViewByChange}
      />
      <AnalyticsSelectField
        label="Time range"
        value={toTimeRangeSelectValue(timePeriod)}
        showLabel={false}
        layout="inline"
        options={ANALYTICS_TIME_RANGE_OPTIONS.map((option) => ({
          value: toTimeRangeSelectValue(option.value),
          label: option.label,
        }))}
        onChange={(value) =>
          onTimePeriodChange(
            value === 'all' ? 'all' : (Number(value) as TimePeriodFilter),
          )
        }
      />
      <AnalyticsGranularitySelector
        value={granularity}
        availableGranularities={availableGranularities}
        onChange={onGranularityChange}
      />
    </>
  );
}
