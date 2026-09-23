'use client';

import { ListEnd } from '@/components/system';
import { cn } from '@/lib/utils';

export type SessionQueuedMessage = {
  id: string;
  text: string;
  images?: string[];
};

type SessionQueuedMessageListProps = {
  queuedMessages: SessionQueuedMessage[];
  className?: string;
};

export function SessionQueuedMessageList({
  queuedMessages,
  className,
}: SessionQueuedMessageListProps) {
  if (queuedMessages.length === 0) return null;
  return (
    <ul
      aria-label="Queued messages"
      className={cn('border-b border-border/50', className)}
    >
      {queuedMessages.map((queued) => {
        const text =
          queued.text.trim().length > 0 ? queued.text : '(queued images)';
        return (
          <li
            key={queued.id}
            className="flex min-h-9 min-w-0 items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground"
          >
            <ListEnd aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={text}>
              {text}
            </span>
            <span className="ml-auto shrink-0 pl-2">Queued</span>
          </li>
        );
      })}
    </ul>
  );
}
