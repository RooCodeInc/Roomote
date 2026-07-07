'use client';

import type { AnalyticsGranularity } from '@/types';
import { ANALYTICS_GRANULARITY_LABELS } from '@/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

type AnalyticsGranularitySelectorProps = {
  value: AnalyticsGranularity;
  availableGranularities: AnalyticsGranularity[];
  onChange: (value: AnalyticsGranularity) => void;
};

export function AnalyticsGranularitySelector({
  value,
  availableGranularities,
  onChange,
}: AnalyticsGranularitySelectorProps) {
  return (
    <div className="flex justify-center">
      <Select
        value={value}
        onValueChange={(next) => onChange(next as AnalyticsGranularity)}
      >
        <SelectTrigger
          aria-label="Chart granularity"
          className="justify-center text-center"
        >
          <SelectValue placeholder="Chart granularity" />
        </SelectTrigger>
        <SelectContent>
          {availableGranularities.map((option) => (
            <SelectItem key={option} value={option}>
              {ANALYTICS_GRANULARITY_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
