'use client';

import { useMemo } from 'react';
import { groupModelsByDisplayProvider } from '@roomote/types';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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

function modelOptionLabel(model: {
  displayName: string;
  isDefault?: boolean;
}): string {
  return `${model.displayName}${model.isDefault ? ' (Default)' : ''}`;
}

export function ModelSelect({
  value,
  onValueChange,
  disabled = false,
  className,
  ariaLabel = 'Model',
}: ModelSelectProps) {
  const { data, isPending } = useLaunchTaskModels();
  const modelGroups = useMemo(() => {
    const sortedModels = [...(data?.models ?? [])].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );

    return groupModelsByDisplayProvider(sortedModels, {
      chatgptConnected: data?.chatgptConnected,
      openaiConnected: data?.openaiConnected,
      xaiSubscriptionConnected: data?.xaiSubscriptionConnected,
      xaiConnected: data?.xaiConnected,
    });
  }, [
    data?.chatgptConnected,
    data?.openaiConnected,
    data?.xaiSubscriptionConnected,
    data?.xaiConnected,
    data?.models,
  ]);
  const showProviderHeaders = modelGroups.length > 1;

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
        {showProviderHeaders
          ? modelGroups.map((group) => (
              <SelectGroup key={group.providerId}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.items.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {modelOptionLabel(model)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))
          : modelGroups.flatMap((group) =>
              group.items.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {modelOptionLabel(model)}
                </SelectItem>
              )),
            )}
      </SelectContent>
    </Select>
  );
}
