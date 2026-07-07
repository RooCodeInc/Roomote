import {
  type AcpMessage,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  asFiniteNumber,
  asString,
  extractAcpMessageText,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

import { getAcpClientMessageId } from './acp-client-message-id';

export function appendOptimisticPromptEnvelope(
  current: TaskMessageEnvelope[] | undefined,
  envelope: TaskMessageEnvelope,
): TaskMessageEnvelope[] | undefined {
  if (!current) {
    return current;
  }

  const clientMessageId = getAcpClientMessageId(envelope);

  if (!clientMessageId) {
    return [...current, envelope];
  }

  const existingIndex = current.findIndex(
    (entry) =>
      entry.metadata?.optimistic === true &&
      entry.role === 'user' &&
      getAcpClientMessageId(entry) === clientMessageId,
  );

  if (existingIndex === -1) {
    return [...current, envelope];
  }

  const next = current.slice();
  next[existingIndex] = envelope;
  return next;
}

export function removeOptimisticPromptEnvelope(
  current: TaskMessageEnvelope[] | undefined,
  clientMessageId: string,
): TaskMessageEnvelope[] | undefined {
  if (!current) {
    return current;
  }

  const next = current.filter(
    (entry) =>
      !(
        entry.metadata?.optimistic === true &&
        entry.role === 'user' &&
        getAcpClientMessageId(entry) === clientMessageId
      ),
  );

  return next.length === current.length ? current : next;
}

export function replaceOptimisticPromptEnvelope(
  current: TaskMessageEnvelope[] | undefined,
  taskId: string,
  event: AcpMessage,
): TaskMessageEnvelope[] | undefined {
  if (!current) {
    return current;
  }

  const clientMessageId = getAcpClientMessageId(event);

  if (!clientMessageId) {
    return current;
  }

  const existingIndex = current.findIndex(
    (entry) =>
      entry.metadata?.optimistic === true &&
      entry.role === 'user' &&
      getAcpClientMessageId(entry) === clientMessageId,
  );

  if (existingIndex === -1) {
    return current;
  }

  const optimisticEnvelope = current[existingIndex];
  if (!optimisticEnvelope) {
    return current;
  }

  const next = current.slice();
  next[existingIndex] = createPromptEnvelopeFromAcpEvent(
    taskId,
    event,
    optimisticEnvelope,
  );
  return next;
}

function createPromptEnvelopeFromAcpEvent(
  taskId: string,
  event: AcpMessage,
  optimisticEnvelope: TaskMessageEnvelope,
): TaskMessageEnvelope {
  const metadata = event.metadata ?? null;
  const payload = event.payload ?? {};
  const metadataRecord = metadata ?? {};

  return {
    id: event.id,
    userId:
      event.userId ??
      asString(payload.userId) ??
      asString(metadataRecord.userId) ??
      optimisticEnvelope.userId ??
      null,
    userName:
      event.userName ??
      asString(payload.userName) ??
      asString(metadataRecord.userName) ??
      optimisticEnvelope.userName ??
      null,
    userEmail:
      asString(payload.userEmail) ??
      asString(metadataRecord.userEmail) ??
      optimisticEnvelope.userEmail ??
      null,
    userImageUrl:
      event.userImageUrl ??
      asString(payload.userImageUrl) ??
      asString(metadataRecord.userImageUrl) ??
      optimisticEnvelope.userImageUrl ??
      null,
    taskId,
    ts: event.ts,
    createdAt: event.ts,
    sequence: asFiniteNumber(metadata?.sequence) ?? null,
    eventType: event.eventType,
    role: event.role,
    kind: event.kind,
    protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    contentBlocks: event.contentBlocks,
    metadata,
    payload,
    visibleInTranscript: event.visibleInTranscript,
    text: event.text ?? extractAcpMessageText(event.contentBlocks, payload),
  };
}
