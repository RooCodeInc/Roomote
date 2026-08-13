'use client';

import {
  REASONING_EFFORT_OPTIONS,
  normalizeOptionalReasoningEffort,
  type ReasoningEffort,
} from '@roomote/types';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

/**
 * Reasoning-level picker shared by the admin model settings page and the
 * in-task model switcher. Shows the effective level (explicit value or the
 * provided default) and reports every change as an explicit selection.
 */
export function ReasoningEffortSelect({
  value,
  defaultEffort,
  onChange,
  disabled,
  ariaLabel,
  className = 'w-36 shrink-0',
  size,
  supportedEfforts,
}: {
  value: ReasoningEffort | null;
  defaultEffort: ReasoningEffort;
  onChange: (value: ReasoningEffort | null) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  size?: 'sm' | 'default';
  /**
   * Restricts the offered levels to what the selected model accepts (from
   * model metadata). The current value stays listed even when unsupported so
   * the control never shows a blank selection; runtime stamping clamps it.
   */
  supportedEfforts?: readonly ReasoningEffort[] | null;
}) {
  const options = REASONING_EFFORT_OPTIONS.filter(
    (option) =>
      !supportedEfforts ||
      supportedEfforts.length === 0 ||
      supportedEfforts.includes(option.value) ||
      option.value === (value ?? defaultEffort),
  );

  return (
    <Select
      value={value ?? defaultEffort}
      onValueChange={(nextValue) =>
        onChange(normalizeOptionalReasoningEffort(nextValue))
      }
      disabled={disabled}
    >
      <SelectTrigger className={className} aria-label={ariaLabel} size={size}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectLabel className="mt-0">Reasoning Level</SelectLabel>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
