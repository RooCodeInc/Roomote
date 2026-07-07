'use client';

import {
  type AnalyticsDimension,
  type AnalyticsObject,
  ANALYTICS_DIMENSION_LABELS,
  ANALYTICS_OBJECT_CONFIG,
} from '@/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

import { ANALYTICS_DIMENSION_ICONS } from './AnalyticsDimensionIcons';

type AnalyticsGroupByProps = {
  object: AnalyticsObject;
  value: AnalyticsDimension;
  onChange: (value: AnalyticsDimension) => void;
};

export function AnalyticsGroupBy({
  object,
  value,
  onChange,
}: AnalyticsGroupByProps) {
  const options = ANALYTICS_OBJECT_CONFIG[object].viewByDimensions;

  return (
    <div className="flex flex-col items-start gap-2 md:flex-row md:flex-nowrap md:items-center md:gap-3 justify-end grow">
      <Select
        value={value}
        onValueChange={(next) => onChange(next as AnalyticsDimension)}
      >
        <SelectTrigger aria-label="View by" className="min-w-[160px]">
          <SelectValue placeholder="By" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            const Icon = ANALYTICS_DIMENSION_ICONS[option];

            return (
              <SelectItem key={option} value={option}>
                <span className="flex items-center gap-2">
                  <Icon className="size-4" />
                  By {ANALYTICS_DIMENSION_LABELS[option]}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
