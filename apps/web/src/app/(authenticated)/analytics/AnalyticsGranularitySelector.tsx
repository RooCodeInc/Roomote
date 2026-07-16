'use client';

import type { AnalyticsGranularity } from '@/types';
import { ANALYTICS_GRANULARITY_LABELS } from '@/types';
import { cn } from '@/lib/utils';
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
  className?: string;
  triggerClassName?: string;
};

export function AnalyticsGranularitySelector({
  value,
  availableGranularities,
  onChange,
  className,
  triggerClassName,
}: AnalyticsGranularitySelectorProps) {
  return (
    <div className={cn('flex', className)}>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as AnalyticsGranularity)}
      >
        <SelectTrigger
          aria-label="Chart granularity"
          className={triggerClassName}
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
