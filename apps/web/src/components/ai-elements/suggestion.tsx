'use client';

import type { ComponentProps } from 'react';
import { Check, CopyIconButton } from '@/components/system';

import { cn } from '@/lib/utils';

type SuggestionsProps = ComponentProps<'div'>;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <div className={cn('flex flex-col items-start gap-2', className)} {...props}>
    {children}
  </div>
);

type SuggestionProps = Omit<ComponentProps<'div'>, 'onClick'> & {
  suggestion: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  selected,
  onClick,
  className,
  disabled = false,
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => {
    if (disabled) return;
    onClick?.(suggestion);
  };

  return (
    <div className="group/suggestion relative inline-flex md:mr-10 mb-1">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-pressed={selected || undefined}
        className={cn(
          'inline-flex items-start gap-2 rounded-lg px-4 py-2 text-sm bg-card transition-colors',
          !disabled &&
            !selected &&
            'cursor-pointer hover:text-accent-foreground',
          disabled && !selected && 'cursor-default opacity-50',
          selected &&
            'cursor-default text-accent-foreground bg-foreground dark:bg-card',
          className,
        )}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        {...props}
      >
        {children || suggestion}
        {selected && <Check className="size-4 text-accent-foreground" />}
      </div>
      <CopyIconButton
        content={suggestion}
        tooltip="Copy suggestion"
        className="absolute -right-1 top-5 -translate-y-1/2 translate-x-full opacity-0 transition-opacity group-hover/suggestion:opacity-50 hover:opacity-100 size-7"
        iconClassName="size-3"
        size="icon"
        variant="ghost"
      />
    </div>
  );
};
