'use client';

import type {
  AnalyticsDimension,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';
import { ANALYTICS_TIME_RANGE_OPTIONS } from '@/types';

import {
  AnalyticsSelectField,
  toTimeRangeSelectValue,
} from './AnalyticsSelectField';
import { AnalyticsGroupBy } from './AnalyticsGroupBy';

type AnalyticsControlRowProps = {
  object: AnalyticsObject;
  viewBy: AnalyticsDimension;
  timePeriod: TimePeriodFilter;
  onViewByChange: (value: AnalyticsDimension) => void;
  onTimePeriodChange: (value: TimePeriodFilter) => void;
};

export function AnalyticsControlRow({
  object,
  viewBy,
  timePeriod,
  onViewByChange,
  onTimePeriodChange,
}: AnalyticsControlRowProps) {
  return (
    <>
      <AnalyticsGroupBy
        object={object}
        value={viewBy}
        onChange={onViewByChange}
      />

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
