'use client';

import type { AnalyticsMetric, AnalyticsObject } from '@/types';
import { ANALYTICS_METRIC_LABELS, ANALYTICS_OBJECT_CONFIG } from '@/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

type AnalyticsMetricSelectorProps = {
  object: AnalyticsObject;
  value: AnalyticsMetric;
  onChange: (value: AnalyticsMetric) => void;
};

export function AnalyticsMetricSelector({
  object,
  value,
  onChange,
}: AnalyticsMetricSelectorProps) {
  const options = ANALYTICS_OBJECT_CONFIG[object].supportedMetrics;

  if (options.length <= 1) {
    return null;
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as AnalyticsMetric)}
    >
      <SelectTrigger aria-label="Metric" className="min-w-[140px]">
        <SelectValue placeholder="Metric" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {ANALYTICS_METRIC_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
