import type { QueuedMessage } from '../../types';

const QUEUED_MESSAGES_UPDATE_CAUSES = [
  'enqueue',
  'dequeue',
  'delete',
  'prioritize',
  'move',
  'clear',
  'restore',
] as const;

export type QueuedMessagesUpdateCause =
  (typeof QUEUED_MESSAGES_UPDATE_CAUSES)[number];

const QUEUED_MESSAGES_UPDATE_CAUSE_SET = new Set<string>(
  QUEUED_MESSAGES_UPDATE_CAUSES,
);

type QueuedMessageState = {
  queuedMessages: QueuedMessage[];
  runtimeQueuedMessages: QueuedMessage[];
  optimisticQueuedMessages: QueuedMessage[];
};

export function getQueuedMessagesUpdateCause(
  payload: Record<string, unknown>,
): QueuedMessagesUpdateCause | null {
  const cause = payload.cause;

  return typeof cause === 'string' &&
    QUEUED_MESSAGES_UPDATE_CAUSE_SET.has(cause)
    ? (cause as QueuedMessagesUpdateCause)
    : null;
}

export function createQueuedMessageState(
  runtimeQueuedMessages: QueuedMessage[],
  optimisticQueuedMessages: QueuedMessage[] = [],
): QueuedMessageState {
  return {
    runtimeQueuedMessages,
    optimisticQueuedMessages,
    queuedMessages: mergeQueuedMessages(
      runtimeQueuedMessages,
      optimisticQueuedMessages,
    ),
  };
}

export function reconcileQueuedMessagesUpdate(
  current: QueuedMessageState,
  incomingRuntimeQueuedMessages: QueuedMessage[],
  cause: QueuedMessagesUpdateCause | null,
): QueuedMessageState {
  const optimisticQueuedMessages =
    cause === 'delete' || cause === 'clear'
      ? removeDeletedAcknowledgedOptimisticQueuedMessages({
          previousRuntimeQueuedMessages: current.runtimeQueuedMessages,
          incomingRuntimeQueuedMessages,
          optimisticQueuedMessages: current.optimisticQueuedMessages,
        })
      : current.optimisticQueuedMessages;

  return createQueuedMessageState(
    incomingRuntimeQueuedMessages,
    optimisticQueuedMessages,
  );
}

export function addOptimisticQueuedMessage(
  current: QueuedMessageState,
  queuedMessage: QueuedMessage,
): QueuedMessageState {
  const optimisticQueuedMessages = upsertOptimisticQueuedMessage(
    current.optimisticQueuedMessages,
    {
      ...queuedMessage,
      optimistic: true,
    },
  );

  return createQueuedMessageState(
    current.runtimeQueuedMessages,
    optimisticQueuedMessages,
  );
}

export function removeOptimisticQueuedMessageFromState(
  current: QueuedMessageState,
  clientMessageId: string,
): QueuedMessageState {
  const optimisticQueuedMessages = removeQueuedMessagesByClientMessageId(
    current.optimisticQueuedMessages,
    clientMessageId,
  );

  return optimisticQueuedMessages === current.optimisticQueuedMessages
    ? current
    : createQueuedMessageState(
        current.runtimeQueuedMessages,
        optimisticQueuedMessages,
      );
}

export function removeQueuedMessagesByClientMessageIdFromState(
  current: QueuedMessageState,
  clientMessageId: string,
): QueuedMessageState {
  const runtimeQueuedMessages = removeQueuedMessagesByClientMessageId(
    current.runtimeQueuedMessages,
    clientMessageId,
  );
  const optimisticQueuedMessages = removeQueuedMessagesByClientMessageId(
    current.optimisticQueuedMessages,
    clientMessageId,
  );

  return runtimeQueuedMessages === current.runtimeQueuedMessages &&
    optimisticQueuedMessages === current.optimisticQueuedMessages
    ? current
    : createQueuedMessageState(runtimeQueuedMessages, optimisticQueuedMessages);
}

function mergeQueuedMessages(
  runtimeQueuedMessages: QueuedMessage[],
  optimisticQueuedMessages: QueuedMessage[],
): QueuedMessage[] {
  const queuedClientMessageIds = getQueuedMessageClientMessageIds(
    runtimeQueuedMessages,
  );

  const visibleOptimisticQueuedMessages = optimisticQueuedMessages.filter(
    (queuedMessage) =>
      !queuedMessage.clientMessageId ||
      !queuedClientMessageIds.has(queuedMessage.clientMessageId),
  );

  return runtimeQueuedMessages.concat(visibleOptimisticQueuedMessages);
}

function getQueuedMessageClientMessageIds(
  queuedMessages: QueuedMessage[],
): Set<string> {
  const clientMessageIds = new Set<string>();

  for (const queuedMessage of queuedMessages) {
    if (typeof queuedMessage.clientMessageId === 'string') {
      clientMessageIds.add(queuedMessage.clientMessageId);
    }
  }

  return clientMessageIds;
}

function removeDeletedAcknowledgedOptimisticQueuedMessages({
  previousRuntimeQueuedMessages,
  incomingRuntimeQueuedMessages,
  optimisticQueuedMessages,
}: {
  previousRuntimeQueuedMessages: QueuedMessage[];
  incomingRuntimeQueuedMessages: QueuedMessage[];
  optimisticQueuedMessages: QueuedMessage[];
}): QueuedMessage[] {
  if (
    previousRuntimeQueuedMessages.length === 0 ||
    optimisticQueuedMessages.length === 0
  ) {
    return optimisticQueuedMessages;
  }

  const previousRuntimeClientMessageIds = getQueuedMessageClientMessageIds(
    previousRuntimeQueuedMessages,
  );

  if (previousRuntimeClientMessageIds.size === 0) {
    return optimisticQueuedMessages;
  }

  const incomingRuntimeClientMessageIds = getQueuedMessageClientMessageIds(
    incomingRuntimeQueuedMessages,
  );
  const nextOptimisticQueuedMessages = optimisticQueuedMessages.filter(
    (queuedMessage) => {
      const clientMessageId =
        typeof queuedMessage.clientMessageId === 'string'
          ? queuedMessage.clientMessageId
          : null;

      return (
        !clientMessageId ||
        !previousRuntimeClientMessageIds.has(clientMessageId) ||
        incomingRuntimeClientMessageIds.has(clientMessageId)
      );
    },
  );

  return nextOptimisticQueuedMessages.length === optimisticQueuedMessages.length
    ? optimisticQueuedMessages
    : nextOptimisticQueuedMessages;
}

function upsertOptimisticQueuedMessage(
  optimisticQueuedMessages: QueuedMessage[],
  queuedMessage: QueuedMessage,
): QueuedMessage[] {
  const clientMessageId =
    typeof queuedMessage.clientMessageId === 'string'
      ? queuedMessage.clientMessageId
      : null;

  if (!clientMessageId) {
    return optimisticQueuedMessages.concat(queuedMessage);
  }

  const existingIndex = optimisticQueuedMessages.findIndex(
    (message) => message.clientMessageId === clientMessageId,
  );

  if (existingIndex === -1) {
    return optimisticQueuedMessages.concat(queuedMessage);
  }

  const next = optimisticQueuedMessages.slice();
  next[existingIndex] = queuedMessage;
  return next;
}

function removeQueuedMessagesByClientMessageId(
  queuedMessages: QueuedMessage[],
  clientMessageId: string,
): QueuedMessage[] {
  const next = queuedMessages.filter(
    (queuedMessage) => queuedMessage.clientMessageId !== clientMessageId,
  );

  return next.length === queuedMessages.length ? queuedMessages : next;
}
