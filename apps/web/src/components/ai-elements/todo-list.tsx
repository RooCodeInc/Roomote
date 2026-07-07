'use client';

import {
  ArrowRightIcon,
  CheckIcon,
  ListChecks,
  SquareDashedIcon,
} from '@/components/system';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIconTrigger,
  CollapsibleTrigger,
  ScrollArea,
} from '@/components/system';

type TodoListItemProps = ComponentProps<'li'> & {
  completed?: boolean;
  inProgress?: boolean;
};

export const TodoListItem = ({
  completed = false,
  inProgress = false,
  className,
  ...props
}: TodoListItemProps) => (
  <li
    data-completed={completed}
    className={cn(
      'group flex flex-col gap-2 rounded-md px-3 py-1 text-sm transition-colors text-muted-foregound text-xs cursor-default',
      !inProgress && 'text-muted-foreground/70',
      className,
    )}
    {...props}
  />
);

type TodoListItemIndicatorProps = ComponentProps<'span'> & {
  completed?: boolean;
  inProgress?: boolean;
};

export const TodoListItemIndicator = ({
  completed = false,
  inProgress = false,
  className,
  ...props
}: TodoListItemIndicatorProps) => (
  <span
    className={cn('inline-flex items-center justify-center', className)}
    {...props}
  >
    {completed ? (
      <CheckIcon className="size-3" />
    ) : inProgress ? (
      <ArrowRightIcon className="size-3" />
    ) : (
      <SquareDashedIcon className="size-3" />
    )}
  </span>
);

type TodoListItemContentProps = ComponentProps<'span'> & {
  completed?: boolean;
};

export const TodoListItemContent = ({
  className,
  ...props
}: TodoListItemContentProps) => (
  <span className={cn('line-clamp-1 grow break-words', className)} {...props} />
);

type TodoListItemsProps = ComponentProps<typeof ScrollArea>;

export const TodoListItems = ({
  children,
  className,
  ...props
}: TodoListItemsProps) => (
  <ScrollArea className={cn('pl-1 -mt-1', className)} {...props}>
    <div className="max-h-40 pr-4">
      <ul>{children}</ul>
    </div>
  </ScrollArea>
);

type TodoListSectionProps = ComponentProps<typeof Collapsible> & {
  allCompleted?: boolean;
};

export const TodoListSection = ({
  className,
  allCompleted = false,
  defaultOpen = !allCompleted,
  ...props
}: TodoListSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

type TodoListSectionTriggerProps = ComponentProps<'button'>;

export const TodoListSectionTrigger = ({
  children,
  className,
  ...props
}: TodoListSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        'group flex w-full items-center justify-between px-4 py-2 text-left font-medium text-muted-foreground text-sm transition-colors cursor-pointer',
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
);

type TodoListSectionLabelProps = ComponentProps<'span'> & {
  count?: number;
  label: string;
  icon?: React.ReactNode;
};

export const TodoListSectionLabel = ({
  count,
  label,
  className,
  ...props
}: TodoListSectionLabelProps) => (
  <span
    className={cn(
      'flex items-center gap-2 text-xs text-muted-foreground font-regular',
      className,
    )}
    {...props}
  >
    <CollapsibleIconTrigger icon={ListChecks} />
    <span>
      {count != null ? `${count} ` : ''}
      {label}
    </span>
  </span>
);

type TodoListSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const TodoListSectionContent = ({
  className,
  ...props
}: TodoListSectionContentProps) => (
  <CollapsibleContent className={cn('pb-3', className)} {...props} />
);

type TodoListProps = ComponentProps<'div'>;

export const TodoList = ({ className, ...props }: TodoListProps) => (
  <div className={cn('flex flex-col gap-2', className)} {...props} />
);
