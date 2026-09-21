'use client';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import type {
  DisplayModelProviderGroup,
  TaskModelMetadata,
} from '@roomote/types';

export type EditableRuntimeModelOption = {
  id: string;
  displayName: string;
  family?: string;
  metadata?: TaskModelMetadata | null;
};

export function TaskModelSelect({
  value,
  optionGroups,
  placeholder,
  disabled,
  ariaLabel,
  sameAsCodingModelValue,
  onValueChange,
}: {
  value: string;
  optionGroups: DisplayModelProviderGroup<EditableRuntimeModelOption>[];
  placeholder: string;
  disabled?: boolean;
  ariaLabel?: string;
  sameAsCodingModelValue?: string;
  onValueChange: (value: string) => void;
}) {
  const showProviderHeaders = optionGroups.length > 1;

  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || optionGroups.length === 0}
    >
      <SelectTrigger className="w-full sm:max-w-sm" aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {sameAsCodingModelValue ? (
          <SelectItem value={sameAsCodingModelValue}>
            Same as coding model
          </SelectItem>
        ) : null}
        {showProviderHeaders
          ? optionGroups.map((group) => (
              <SelectGroup key={group.providerId}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.items.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.displayName}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))
          : optionGroups.flatMap((group) =>
              group.items.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.displayName}
                </SelectItem>
              )),
            )}
      </SelectContent>
    </Select>
  );
}
