'use client';

import type { TimePeriodFilter } from '@/types';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

type AnalyticsSelectOption = {
  value: string;
  label: string;
};

type AnalyticsSelectFieldProps = {
  label: string;
  value: string;
  options: AnalyticsSelectOption[];
  onChange: (value: string) => void;
  showLabel?: boolean;
  layout?: 'inline' | 'stacked';
  triggerClassName?: string;
};

export function toTimeRangeSelectValue(value: TimePeriodFilter) {
  return value === 'all' ? 'all' : String(value);
}

export function AnalyticsSelectField({
  label,
  value,
  options,
  onChange,
  showLabel = true,
  layout = 'stacked',
  triggerClassName,
}: AnalyticsSelectFieldProps) {
  const isInline = layout === 'inline';

  return (
    <div className={isInline ? 'flex items-center gap-2' : 'space-y-2'}>
      {showLabel ? (
        <div
          className={cn(
            'text-sm font-medium',
            isInline ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {label}
        </div>
      ) : null}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          aria-label={label}
          className={cn(
            isInline ? 'min-w-[100px]' : 'w-full bg-background',
            triggerClassName,
          )}
        >
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
