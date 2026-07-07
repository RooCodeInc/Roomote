import type { QueuedMessage } from '../types';

export function parseAcpQueuedMessagesPayload(
  update: Record<string, unknown>,
): QueuedMessage[] | null {
  if (!Array.isArray(update.queuedMessages)) {
    return null;
  }

  return update.queuedMessages.filter(isQueuedMessage);
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const msg = value as Partial<QueuedMessage>;

  return (
    typeof msg.id === 'string' &&
    typeof msg.text === 'string' &&
    typeof msg.timestamp === 'number' &&
    (msg.images === undefined ||
      (Array.isArray(msg.images) &&
        msg.images.every((img) => typeof img === 'string'))) &&
    (msg.userName === undefined || typeof msg.userName === 'string') &&
    (msg.userImageUrl === undefined || typeof msg.userImageUrl === 'string') &&
    (msg.clientMessageId === undefined ||
      typeof msg.clientMessageId === 'string')
  );
}
