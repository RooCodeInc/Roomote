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
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';

type ModelSelectProps = {
  value?: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /**
   * When set, renders this label as a leading option that maps to the empty
   * string value, for pickers where "no override" is a valid choice.
   */
  emptyOptionLabel?: string;
  /** Trigger size; use 'default' to line up with default-size form controls. */
  size?: 'sm' | 'default';
};

// Radix Select items cannot use an empty-string value, so the empty option
// round-trips through this sentinel.
const EMPTY_OPTION_VALUE = '__model-select-empty__';

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
  emptyOptionLabel,
  size = 'sm',
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
      value={emptyOptionLabel && !value ? EMPTY_OPTION_VALUE : value}
      onValueChange={(next) =>
        onValueChange(next === EMPTY_OPTION_VALUE ? '' : next)
      }
      disabled={disabled || isPending || !data}
    >
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        {emptyOptionLabel ? (
          <SelectItem value={EMPTY_OPTION_VALUE}>{emptyOptionLabel}</SelectItem>
        ) : null}
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
