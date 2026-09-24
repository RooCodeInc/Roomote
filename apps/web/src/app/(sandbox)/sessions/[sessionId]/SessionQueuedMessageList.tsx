'use client';

import { useState } from 'react';

import {
  BasicTooltip,
  Button,
  ListEnd,
  Loader2,
  Trash2,
} from '@/components/system';
import { cn } from '@/lib/utils';

export type SessionQueuedMessage = {
  id: string;
  clientMessageId: string;
  /** Sender; only they may delete the message while it waits. */
  userId?: string;
  text: string;
  images?: string[];
};

/**
 * `withdrawn` once the message has left the queue; `not_queued` when the
 * agent already has it, so it can no longer be deleted.
 */
export type SessionQueuedMessageDeleteOutcome = 'withdrawn' | 'not_queued';

type SessionQueuedMessageListProps = {
  queuedMessages: SessionQueuedMessage[];
  /** The viewer; the delete control is enabled on their own messages. */
  currentUserId?: string | null;
  /** Omitted for viewers who cannot act on the Session. */
  onDelete?: (
    message: SessionQueuedMessage,
  ) => Promise<SessionQueuedMessageDeleteOutcome>;
  className?: string;
};

function QueuedMessageRow({
  message,
  currentUserId,
  onDelete,
}: Pick<SessionQueuedMessageListProps, 'currentUserId' | 'onDelete'> & {
  message: SessionQueuedMessage;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text =
    message.text.trim().length > 0 ? message.text : '(queued images)';
  const canDelete = Boolean(currentUserId) && message.userId === currentUserId;

  const remove = async () => {
    if (!onDelete) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await onDelete(message);
      if (outcome === 'not_queued') {
        setError('Already sent to the agent.');
      }
    } catch {
      setError('Could not delete this message. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <li>
      <div className="flex min-h-9 min-w-0 items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground">
        <ListEnd aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate" title={text}>
          {text}
        </span>
        <span className="ml-auto shrink-0 pl-2">Queued</span>
        {onDelete ? (
          <BasicTooltip
            content={
              canDelete
                ? 'Delete queued message'
                : 'Only the sender can delete this message'
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-md focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={
                pending ? 'Deleting queued message' : 'Delete queued message'
              }
              aria-busy={pending}
              disabled={pending || !canDelete}
              onClick={() => void remove()}
            >
              {pending ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" />
              )}
            </Button>
          </BasicTooltip>
        ) : null}
      </div>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function SessionQueuedMessageList({
  queuedMessages,
  currentUserId,
  onDelete,
  className,
}: SessionQueuedMessageListProps) {
  if (queuedMessages.length === 0) return null;
  return (
    <ul
      aria-label="Queued messages"
      className={cn('border-b border-border/50', className)}
    >
      {queuedMessages.map((message) => (
        // The client id survives the optimistic entry being replaced by the
        // server's row, so a pending delete keeps its state.
        <QueuedMessageRow
          key={message.clientMessageId}
          message={message}
          currentUserId={currentUserId}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}
