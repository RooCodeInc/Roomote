'use client';

import { useMemo, useState } from 'react';
import { groupModelsByDisplayProvider } from '@roomote/types';

import {
  Button,
  Check,
  ChevronsUpDown,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { cn } from '@/lib/utils';

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
  const [open, setOpen] = useState(false);
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

  if (data && data.models.length > 8) {
    const selectedModel = data.models.find((model) => model.id === value);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={size}
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel}
            disabled={disabled || isPending}
            className={cn(
              'w-fit justify-between gap-2 border-input bg-card px-3 text-sm font-normal has-[>svg]:px-3 hover:bg-card hover:text-accent-foreground hover:border-accent-foreground',
              className,
            )}
          >
            <span className="truncate text-left">
              {emptyOptionLabel && !value
                ? emptyOptionLabel
                : selectedModel
                  ? modelOptionLabel(selectedModel)
                  : 'Model'}
            </span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-0"
        >
          <Command>
            <CommandInput placeholder="Search models..." />
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              {emptyOptionLabel ? (
                <CommandGroup>
                  <CommandItem
                    value={EMPTY_OPTION_VALUE}
                    keywords={[emptyOptionLabel]}
                    onSelect={() => {
                      onValueChange('');
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-4',
                        value ? 'opacity-0' : 'opacity-100',
                      )}
                    />
                    <span className="truncate">{emptyOptionLabel}</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {modelGroups.map((group) => (
                <CommandGroup
                  key={group.providerId}
                  heading={showProviderHeaders ? group.label : undefined}
                >
                  {group.items.map((model) => (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      keywords={[modelOptionLabel(model)]}
                      onSelect={() => {
                        onValueChange(model.id);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 size-4',
                          model.id === value ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="truncate">
                        {modelOptionLabel(model)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }

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
