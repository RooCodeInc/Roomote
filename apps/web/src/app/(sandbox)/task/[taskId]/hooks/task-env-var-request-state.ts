import {
  ACP_ENVELOPE_EVENT_TYPES,
  type TaskEnvVarRequestVariable,
  ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX,
  getRequestedDeploymentEnvVarNamesFromToolPayload,
  isEnvVarRequestFulfillmentClientMessageId,
  asRecord,
  asString,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

interface PendingTaskEnvVarRequestEvent {
  id: string;
  ts: number;
  eventType: string;
  payload: Record<string, unknown> | null;
}

export interface PendingTaskEnvVarRequest {
  key: string;
  ts: number;
  variables: TaskEnvVarRequestVariable[];
}

function getPayloadClientMessageId(
  payload: Record<string, unknown> | null,
): string | undefined {
  return asString(asRecord(payload)?.clientMessageId);
}

function getPendingTaskEnvVarRequestKey(
  event: PendingTaskEnvVarRequestEvent,
): string {
  return asString(asRecord(event.payload)?.toolCallId) ?? event.id;
}

export function applyPendingTaskEnvVarEvent(
  pendingRequest: PendingTaskEnvVarRequest | null,
  event: PendingTaskEnvVarRequestEvent,
): PendingTaskEnvVarRequest | null {
  if (event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
    const requestedNames = getRequestedDeploymentEnvVarNamesFromToolPayload(
      event.payload,
    );

    if (requestedNames.length === 0) {
      return pendingRequest;
    }

    return {
      key: getPendingTaskEnvVarRequestKey(event),
      ts: event.ts,
      variables: requestedNames.map((name) => ({ name })),
    };
  }

  if (
    event.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
    isEnvVarRequestFulfillmentClientMessageId(
      getPayloadClientMessageId(event.payload),
    )
  ) {
    return null;
  }

  return pendingRequest;
}

export function isPendingTaskEnvVarLifecycleEvent(event: {
  eventType: string;
  payload: Record<string, unknown> | null;
}): boolean {
  return (
    (event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult &&
      getRequestedDeploymentEnvVarNamesFromToolPayload(event.payload).length >
        0) ||
    (event.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
      isEnvVarRequestFulfillmentClientMessageId(
        getPayloadClientMessageId(event.payload),
      ))
  );
}

export function getPendingTaskEnvVarRequest(
  events: readonly Pick<
    TaskMessageEnvelope,
    'id' | 'ts' | 'eventType' | 'payload'
  >[],
): PendingTaskEnvVarRequest | null {
  return events.reduce<PendingTaskEnvVarRequest | null>(
    (pendingRequest, event) =>
      applyPendingTaskEnvVarEvent(pendingRequest, {
        id: event.id,
        ts: event.ts,
        eventType: event.eventType,
        payload: event.payload,
      }),
    null,
  );
}

export { ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX };
