'use client';

import { useMemo } from 'react';
import { getModelProviderLabel, getTaskModelProviderId } from '@roomote/types';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import { cn } from '@/lib/utils';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';

type ModelSelectProps = {
  value?: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function ModelSelect({
  value,
  onValueChange,
  disabled = false,
  className,
  ariaLabel = 'Model',
}: ModelSelectProps) {
  const { data, isPending } = useLaunchTaskModels();
  const sortedModels = useMemo(
    () =>
      [...(data?.models ?? [])].sort((left, right) => {
        const leftProvider = getModelProviderLabel(
          getTaskModelProviderId(left.id) ?? 'other',
        );
        const rightProvider = getModelProviderLabel(
          getTaskModelProviderId(right.id) ?? 'other',
        );

        return (
          leftProvider.localeCompare(rightProvider) ||
          left.displayName.localeCompare(right.displayName)
        );
      }),
    [data?.models],
  );

  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || isPending || !data}
    >
      <SelectTrigger
        size="sm"
        className={cn('w-40', className)}
        aria-label={ariaLabel}
      >
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        {sortedModels.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.displayName}
            {model.isDefault ? ' (Default)' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
