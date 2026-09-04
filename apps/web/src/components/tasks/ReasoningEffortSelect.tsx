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

const EMPTY_OPTION_VALUE = '__reasoning-effort-select-empty__';

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
  emptyOptionLabel,
}: {
  value: ReasoningEffort | null;
  defaultEffort: ReasoningEffort;
  onChange: (value: ReasoningEffort | null) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  size?: 'sm' | 'default';
  /** Optional label for a null/no-override selection. */
  emptyOptionLabel?: string;
}) {
  return (
    <Select
      value={
        emptyOptionLabel && value === null
          ? EMPTY_OPTION_VALUE
          : (value ?? defaultEffort)
      }
      onValueChange={(nextValue) =>
        onChange(
          nextValue === EMPTY_OPTION_VALUE
            ? null
            : normalizeOptionalReasoningEffort(nextValue),
        )
      }
      disabled={disabled}
    >
      <SelectTrigger className={className} aria-label={ariaLabel} size={size}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectLabel className="mt-0">Reasoning Level</SelectLabel>
          {emptyOptionLabel ? (
            <SelectItem value={EMPTY_OPTION_VALUE}>
              {emptyOptionLabel}
            </SelectItem>
          ) : null}
          {REASONING_EFFORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
