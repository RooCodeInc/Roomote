'use client';

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';
import type { ButtonAsButtonProps } from '@/components/system/primitives/button';

import {
  Button,
  GripVertical,
  ListEnd,
  ScrollArea,
  Trash,
} from '@/components/system';

type QueuedMessagesListProps = ComponentProps<'div'>;

export const QueuedMessagesList = ({
  className,
  ...props
}: QueuedMessagesListProps) => (
  <div className={cn('flex flex-col pt-2', className)} {...props} />
);

export const QueuedMessagesSectionLabel = ({
  className,
  ...props
}: ComponentProps<'span'>) => (
  <span
    className={cn(
      'flex items-center gap-2 px-4 text-xs text-muted-foreground',
      className,
    )}
    {...props}
  >
    <ListEnd className="size-3" strokeWidth={1.5} />
    <span>Queued</span>
  </span>
);

type QueuedMessagesItemsProps = ComponentProps<typeof ScrollArea>;

export const QueuedMessagesItems = ({
  children,
  className,
  ...props
}: QueuedMessagesItemsProps) => (
  <ScrollArea className={cn('', className)} {...props}>
    <div className="max-h-40">
      <ul>{children}</ul>
    </div>
  </ScrollArea>
);

type QueuedMessagesItemProps = ComponentProps<'li'>;

export const QueuedMessagesItem = ({
  className,
  ...props
}: QueuedMessagesItemProps) => (
  <li
    className={cn(
      'group flex flex-row border-b border-background items-center gap-2 rounded-md px-2 py-1.5 text-[0.8em] text-muted-foreground transition-colors',
      className,
    )}
    {...props}
  />
);

type QueuedMessagesItemContentProps = ComponentProps<'span'>;

export const QueuedMessagesItemContent = ({
  className,
  ...props
}: QueuedMessagesItemContentProps) => (
  <span
    className={cn('min-w-0 line-clamp-1 grow wrap-break-words', className)}
    {...props}
  />
);

type QueuedMessagesItemDragHandleProps = ButtonAsButtonProps;

export const QueuedMessagesItemDragHandle = ({
  className,
  ...props
}: QueuedMessagesItemDragHandleProps) => (
  <Button
    type="button"
    variant="bare"
    size="icon"
    className={cn(
      '!size-5 inline-flex shrink-0 cursor-grab rounded p-0.5 ml-1 -mr-1 text-muted-foreground/50 opacity-100 hover:text-accent-foreground focus-visible:opacity-100 active:cursor-grabbing',
      className,
    )}
    {...props}
  >
    <GripVertical className="size-3.5" strokeWidth={1.5} />
  </Button>
);

type QueuedMessagesItemDeleteButtonProps = ButtonAsButtonProps;

export const QueuedMessagesItemDeleteButton = ({
  className,
  ...props
}: QueuedMessagesItemDeleteButtonProps) => (
  <Button
    type="button"
    variant="bare"
    size="icon"
    className={cn(
      '!size-5 inline-flex shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-100 hover:text-accent-foreground focus-visible:opacity-100',
      className,
    )}
    {...props}
  >
    <Trash className="size-3.5" strokeWidth={1.5} />
  </Button>
);
