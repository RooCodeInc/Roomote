'use client';

import { useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
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
} from '@/components/system';

export type SlackChannelOption = {
  id: string;
  name: string;
  label: string;
  isPrivate?: boolean;
  isMember?: boolean | null;
};

export function SlackChannelSelect({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select a Slack channel',
  searchPlaceholder = 'Search channels...',
  emptyMessage = 'No channels found.',
  disabled = false,
  className,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: SlackChannelOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const normalizedValue = value?.trim().toLowerCase() ?? null;
  const selectedOption = useMemo(
    () =>
      options.find((option) => {
        if (!normalizedValue) {
          return false;
        }

        return (
          option.id.toLowerCase() === normalizedValue ||
          option.name.toLowerCase() === normalizedValue ||
          option.label.toLowerCase() === normalizedValue
        );
      }) ?? null,
    [normalizedValue, options],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          size="sm"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', className)}
        >
          <span className="truncate text-left">
            {selectedOption?.label ?? value ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.name} ${option.id}`}
                  keywords={[option.label, option.name, option.id]}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 size-4',
                      option.id === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
