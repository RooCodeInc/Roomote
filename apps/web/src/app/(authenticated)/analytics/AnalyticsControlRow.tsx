'use client';

import type {
  AnalyticsDimension,
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
import { AnalyticsMetricSelector } from './AnalyticsMetricSelector';

type AnalyticsControlRowProps = {
  object: AnalyticsObject;
  viewBy: AnalyticsDimension;
  metric: AnalyticsMetric;
  timePeriod: TimePeriodFilter;
  onViewByChange: (value: AnalyticsDimension) => void;
  onMetricChange: (value: AnalyticsMetric) => void;
  onTimePeriodChange: (value: TimePeriodFilter) => void;
};

export function AnalyticsControlRow({
  object,
  viewBy,
  metric,
  timePeriod,
  onViewByChange,
  onMetricChange,
  onTimePeriodChange,
}: AnalyticsControlRowProps) {
  return (
    <>
      <div className="flex flex-col items-start gap-2 md:flex-row md:flex-nowrap md:items-center md:gap-3 justify-end grow">
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
      </div>

      <div className="hidden items-center gap-4 md:flex">
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
      </div>
    </>
  );
}
