'use client';

import {
  useCallback,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';

import type { QueuedMessage } from './types';

import {
  QueuedMessagesItemDragHandle,
  QueuedMessagesItem,
  QueuedMessagesItemDeleteButton,
  QueuedMessagesItemContent,
  QueuedMessagesItems,
  QueuedMessagesList,
  QueuedMessagesSectionLabel,
} from '@/components/ai-elements';
import { Button, CornerDownLeftIcon } from '@/components/system';
import { cn } from '@/lib/utils';

import { isSteerablePhase } from './steerable-phase';
import {
  useIsInsideSandboxProvider,
  useSandboxClient,
  useSandboxConnected,
  useSandboxQueuedMessages,
  useSandboxReadOnly,
  useSandboxTaskPhase,
} from './hooks/SandboxProvider';

type QueuedMessageDropPosition = 'before' | 'after';

type QueuedMessageReorderInput = {
  queuedMessageId: string;
  targetQueuedMessageId: string;
  position: QueuedMessageDropPosition;
};

type QueuedMessageDropIndicator = {
  targetQueuedMessageId: string;
  position: QueuedMessageDropPosition;
};

function getDropPosition(
  event: ReactDragEvent<HTMLElement>,
): QueuedMessageDropPosition {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY <= bounds.top + bounds.height / 2 ? 'before' : 'after';
}

export type QueuedMessagesContentProps = {
  queuedMessages: QueuedMessage[];
  canSteer?: boolean;
  canReorder?: boolean;
  steeringMessageId?: string | null;
  reorderingMessageId?: string | null;
  onSteerQueuedMessage?: (queuedMessage: QueuedMessage) => void;
  onReorderQueuedMessage?: (
    reorder: QueuedMessageReorderInput,
  ) => void | Promise<void>;
  onDeleteQueuedMessage?: (queuedMessageId: string) => void | Promise<void>;
  deletingQueuedMessageIds?: ReadonlySet<string>;
};

/**
 * Presentational component that renders a scrollable list of queued messages.
 */
export const QueuedMessagesContent = ({
  queuedMessages = [],
  canSteer = false,
  canReorder = false,
  steeringMessageId = null,
  reorderingMessageId = null,
  onSteerQueuedMessage,
  onReorderQueuedMessage,
  onDeleteQueuedMessage,
  deletingQueuedMessageIds,
}: QueuedMessagesContentProps) => {
  const [draggedMessageId, setDraggedMessageId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] =
    useState<QueuedMessageDropIndicator | null>(null);

  const hasPendingQueueMutation =
    steeringMessageId !== null ||
    reorderingMessageId !== null ||
    (deletingQueuedMessageIds?.size ?? 0) > 0;
  const hasOptimisticQueuedMessages = queuedMessages.some(
    (queuedMessage) => queuedMessage.optimistic === true,
  );
  const canDragQueuedMessages =
    canReorder &&
    Boolean(onReorderQueuedMessage) &&
    queuedMessages.length > 1 &&
    !hasPendingQueueMutation &&
    !hasOptimisticQueuedMessages;

  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>, queuedMessageId: string) => {
      if (!canDragQueuedMessages) {
        event.preventDefault();
        return;
      }

      setDraggedMessageId(queuedMessageId);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', queuedMessageId);
    },
    [canDragQueuedMessages],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLLIElement>, targetQueuedMessageId: string) => {
      const activeDraggedMessageId = draggedMessageId;

      if (
        !canDragQueuedMessages ||
        !activeDraggedMessageId ||
        activeDraggedMessageId === targetQueuedMessageId
      ) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';

      const position = getDropPosition(event);

      setDropIndicator((current) => {
        if (
          current?.targetQueuedMessageId === targetQueuedMessageId &&
          current.position === position
        ) {
          return current;
        }

        return { targetQueuedMessageId, position };
      });
    },
    [canDragQueuedMessages, draggedMessageId],
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent<HTMLLIElement>, targetQueuedMessageId: string) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }

      setDropIndicator((current) =>
        current?.targetQueuedMessageId === targetQueuedMessageId
          ? null
          : current,
      );
    },
    [],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLLIElement>, targetQueuedMessageId: string) => {
      event.preventDefault();

      const activeDraggedMessageId = draggedMessageId;

      if (
        !canDragQueuedMessages ||
        !onReorderQueuedMessage ||
        !activeDraggedMessageId ||
        activeDraggedMessageId === targetQueuedMessageId
      ) {
        setDraggedMessageId(null);
        setDropIndicator(null);
        return;
      }

      const position =
        dropIndicator?.targetQueuedMessageId === targetQueuedMessageId
          ? dropIndicator.position
          : getDropPosition(event);

      setDraggedMessageId(null);
      setDropIndicator(null);

      void onReorderQueuedMessage({
        queuedMessageId: activeDraggedMessageId,
        targetQueuedMessageId,
        position,
      });
    },
    [
      canDragQueuedMessages,
      draggedMessageId,
      dropIndicator,
      onReorderQueuedMessage,
    ],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedMessageId(null);
    setDropIndicator(null);
  }, []);

  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div className="2xl:max-w-5xl mx-auto w-full">
      <QueuedMessagesList>
        <QueuedMessagesSectionLabel />
        <QueuedMessagesItems>
          {queuedMessages.map((queued, index) => (
            <QueuedMessagesItem
              key={queued.id}
              className={cn(
                draggedMessageId === queued.id && 'opacity-60',
                dropIndicator?.targetQueuedMessageId === queued.id &&
                  "relative before:pointer-events-none before:absolute before:inset-x-0 before:z-10 before:h-0.5 before:bg-primary before:content-['']",
                dropIndicator?.targetQueuedMessageId === queued.id &&
                  dropIndicator.position === 'before' &&
                  'before:top-0',
                dropIndicator?.targetQueuedMessageId === queued.id &&
                  dropIndicator.position === 'after' &&
                  'before:bottom-0',
              )}
              onDragLeave={(event) => handleDragLeave(event, queued.id)}
              onDragOver={(event) => handleDragOver(event, queued.id)}
              onDrop={(event) => handleDrop(event, queued.id)}
            >
              {canReorder && onReorderQueuedMessage && (
                <QueuedMessagesItemDragHandle
                  aria-label={`Reorder queued message ${index + 1}`}
                  title="Drag to reorder"
                  draggable={canDragQueuedMessages}
                  disabled={!canDragQueuedMessages}
                  onDragEnd={handleDragEnd}
                  onDragStart={(event) => handleDragStart(event, queued.id)}
                />
              )}
              <QueuedMessagesItemContent>
                {queued.text.trim().length > 0
                  ? queued.text
                  : '(queued images)'}
              </QueuedMessagesItemContent>
              {canSteer && onSteerQueuedMessage && (
                <Button
                  aria-label={
                    steeringMessageId === queued.id ? 'Sending...' : 'Send now'
                  }
                  type="button"
                  variant="bare"
                  size="icon"
                  title={
                    steeringMessageId === queued.id ? 'Sending...' : 'Send now'
                  }
                  className="!size-5 inline-flex shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-100 hover:text-accent-foreground focus-visible:opacity-100"
                  disabled={
                    queued.optimistic === true ||
                    steeringMessageId !== null ||
                    reorderingMessageId !== null ||
                    deletingQueuedMessageIds?.has(queued.id)
                  }
                  onClick={() => onSteerQueuedMessage(queued)}
                >
                  <CornerDownLeftIcon className="size-3.5" strokeWidth={1.5} />
                </Button>
              )}
              <QueuedMessagesItemDeleteButton
                aria-label="Delete queued message"
                title="Delete queued message"
                disabled={
                  queued.optimistic === true ||
                  !onDeleteQueuedMessage ||
                  deletingQueuedMessageIds?.has(queued.id) ||
                  steeringMessageId !== null ||
                  reorderingMessageId !== null
                }
                onClick={() => {
                  void onDeleteQueuedMessage?.(queued.id);
                }}
              />
            </QueuedMessagesItem>
          ))}
        </QueuedMessagesItems>
      </QueuedMessagesList>
    </div>
  );
};

/**
 * Connected component that reads queued messages from the sandbox provider.
 */
export const QueuedMessages = () => {
  const isInsideProvider = useIsInsideSandboxProvider();

  if (!isInsideProvider) {
    return null;
  }

  return <ConnectedQueuedMessages />;
};

const ConnectedQueuedMessages = () => {
  const client = useSandboxClient();
  const connected = useSandboxConnected();
  const taskPhase = useSandboxTaskPhase();
  const readOnly = useSandboxReadOnly();
  const queuedMessages = useSandboxQueuedMessages();
  const [steeringMessageId, setSteeringMessageId] = useState<string | null>(
    null,
  );
  const [reorderingMessageId, setReorderingMessageId] = useState<string | null>(
    null,
  );
  const [deletingQueuedMessageIds, setDeletingQueuedMessageIds] = useState<
    Set<string>
  >(new Set());
  const deletingQueuedMessageIdsRef = useRef<Set<string>>(new Set());

  const handleSteerQueuedMessage = useCallback(
    async (queuedMessage: QueuedMessage) => {
      if (
        !client ||
        readOnly ||
        steeringMessageId !== null ||
        reorderingMessageId !== null
      ) {
        return;
      }

      setSteeringMessageId(queuedMessage.id);

      try {
        await client.commands.steerQueuedMessage.mutate({
          queuedMessageId: queuedMessage.id,
        });
      } catch (error) {
        console.error('[sandbox] steerQueuedMessage error:', error);
      } finally {
        setSteeringMessageId(null);
      }
    },
    [client, readOnly, reorderingMessageId, steeringMessageId],
  );

  const handleDeleteQueuedMessage = useCallback(
    async (queuedMessageId: string) => {
      if (
        !client ||
        readOnly ||
        steeringMessageId !== null ||
        reorderingMessageId !== null
      ) {
        return;
      }

      if (deletingQueuedMessageIdsRef.current.has(queuedMessageId)) {
        return;
      }

      deletingQueuedMessageIdsRef.current.add(queuedMessageId);
      setDeletingQueuedMessageIds(new Set(deletingQueuedMessageIdsRef.current));

      try {
        await client.commands.deleteQueuedPrompt.mutate({
          queuedMessageId,
        });
      } catch (error) {
        console.error('[sandbox] deleteQueuedPrompt error:', error);
      } finally {
        deletingQueuedMessageIdsRef.current.delete(queuedMessageId);
        setDeletingQueuedMessageIds(
          new Set(deletingQueuedMessageIdsRef.current),
        );
      }
    },
    [client, readOnly, reorderingMessageId, steeringMessageId],
  );

  const handleReorderQueuedMessage = useCallback(
    async ({
      queuedMessageId,
      targetQueuedMessageId,
      position,
    }: QueuedMessageReorderInput) => {
      if (
        !client ||
        readOnly ||
        steeringMessageId !== null ||
        reorderingMessageId !== null ||
        deletingQueuedMessageIdsRef.current.size > 0
      ) {
        return;
      }

      setReorderingMessageId(queuedMessageId);

      try {
        await client.commands.reorderQueuedMessage.mutate({
          queuedMessageId,
          targetQueuedMessageId,
          position,
        });
      } catch (error) {
        console.error('[sandbox] reorderQueuedMessage error:', error);
      } finally {
        setReorderingMessageId(null);
      }
    },
    [client, readOnly, reorderingMessageId, steeringMessageId],
  );

  return (
    <QueuedMessagesContent
      queuedMessages={queuedMessages}
      canReorder={Boolean(client) && !readOnly}
      canSteer={
        Boolean(client) &&
        !readOnly &&
        isSteerablePhase(taskPhase) &&
        (taskPhase !== 'waiting_for_prompt' || connected)
      }
      reorderingMessageId={reorderingMessageId}
      steeringMessageId={steeringMessageId}
      onReorderQueuedMessage={readOnly ? undefined : handleReorderQueuedMessage}
      onSteerQueuedMessage={handleSteerQueuedMessage}
      onDeleteQueuedMessage={readOnly ? undefined : handleDeleteQueuedMessage}
      deletingQueuedMessageIds={deletingQueuedMessageIds}
    />
  );
};
