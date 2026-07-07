import {
  type AcpRequestUserInputPayload,
  ACP_ENVELOPE_EVENT_TYPES,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputResponsePayload,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

interface PendingUserInputEvent {
  ts: number;
  eventType: string;
  payload: Record<string, unknown> | null;
}

export interface PendingTaskUserInputRequest extends AcpRequestUserInputPayload {
  ts: number;
}

function upsertPendingRequest(
  requests: readonly PendingTaskUserInputRequest[],
  request: PendingTaskUserInputRequest,
): PendingTaskUserInputRequest[] {
  const next = requests.filter(
    (existing) => existing.requestId !== request.requestId,
  );

  next.push(request);
  next.sort((left, right) => left.ts - right.ts);
  return next;
}

export function applyPendingTaskUserInputEvent(
  requests: readonly PendingTaskUserInputRequest[],
  event: PendingUserInputEvent,
): PendingTaskUserInputRequest[] {
  if (event.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
    const payload = parseAcpRequestUserInputPayload(event.payload);

    if (!payload) {
      return requests as PendingTaskUserInputRequest[];
    }

    return upsertPendingRequest(requests, {
      ...payload,
      ts: event.ts,
    });
  }

  if (event.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse) {
    const payload = parseAcpRequestUserInputResponsePayload(event.payload);

    if (!payload) {
      return requests as PendingTaskUserInputRequest[];
    }

    return requests.filter(
      (request) => request.requestId !== payload.requestId,
    );
  }

  return requests as PendingTaskUserInputRequest[];
}

export function getPendingTaskUserInputRequests(
  events: readonly Pick<TaskMessageEnvelope, 'ts' | 'eventType' | 'payload'>[],
): PendingTaskUserInputRequest[] {
  return events.reduce<PendingTaskUserInputRequest[]>(
    (requests, event) =>
      applyPendingTaskUserInputEvent(requests, {
        ts: event.ts,
        eventType: event.eventType,
        payload: event.payload,
      }),
    [],
  );
}
