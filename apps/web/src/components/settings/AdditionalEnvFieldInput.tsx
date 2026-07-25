'use client';

import type { SetupModelProviderEnvField } from '@roomote/types';

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

/**
 * One additional provider env field on a connect surface: a select when the
 * field declares options, a text input otherwise. Shared by the settings
 * dialog and the onboarding step so both render a field the same way.
 */
export function AdditionalEnvFieldInput({
  field,
  value,
  onValueChange,
  disabled,
  ariaLabel,
  inputClassName,
  selectTriggerClassName,
}: {
  field: SetupModelProviderEnvField;
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
  ariaLabel: string;
  inputClassName?: string;
  selectTriggerClassName?: string;
}) {
  if (field.options && field.options.length > 0) {
    return (
      <Select
        value={value || field.options[0]?.value || ''}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <SelectTrigger
          className={selectTriggerClassName}
          aria-label={ariaLabel}
        >
          <SelectValue placeholder={field.placeholder ?? field.label} />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      secret={field.secret}
      className={inputClassName}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      placeholder={field.placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      data-1p-ignore
    />
  );
}
