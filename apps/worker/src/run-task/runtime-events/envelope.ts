import {
  ACP_ENVELOPE_EVENT_TYPES,
  asRecord,
  asString,
  normalizePlanPayload,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputResponsePayload,
  type AcpPersistedEnvelope,
} from '@roomote/types';

import type { CallbackEvent } from '../types';

function getTextFromBlocks(
  contentBlocks: AcpPersistedEnvelope['contentBlocks'],
): string | undefined {
  const text = contentBlocks
    .map((block) => {
      if (block.type !== 'text') {
        return null;
      }

      return typeof block.text === 'string' ? block.text : null;
    })
    .filter((chunk): chunk is string => chunk !== null)
    .join('\n')
    .trim();

  return text.length > 0 ? text : undefined;
}

/**
 * Convert an AcpPersistedEnvelope into zero or more CallbackEvents.
 */
export function fromRuntimeEnvelope(
  envelope: AcpPersistedEnvelope,
): CallbackEvent[] {
  const payload = asRecord(envelope.payload) ?? {};

  if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
    return [{ type: 'turn_started', ts: envelope.ts }];
  }

  if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought) {
    const text =
      getTextFromBlocks(envelope.contentBlocks) ?? asString(payload.text) ?? '';

    if (text.trim().length === 0) {
      return [];
    }

    return [{ type: 'reasoning', text, ts: envelope.ts }];
  }

  if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage) {
    const text =
      getTextFromBlocks(envelope.contentBlocks) ?? asString(payload.text) ?? '';

    if (text.trim().length === 0) {
      return [];
    }

    return [{ type: 'text', text, ts: envelope.ts }];
  }

  if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.Plan) {
    const { entries } = normalizePlanPayload(payload);
    const todos = entries.map((entry, index) => ({
      id: String(index + 1),
      content: entry.content,
      status: entry.status,
    }));

    return [{ type: 'todo_update', todos, ts: envelope.ts }];
  }

  if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
    const request = parseAcpRequestUserInputPayload(payload);

    if (!request) {
      return [];
    }

    return [{ type: 'request_user_input', request, ts: envelope.ts }];
  }

  if (
    envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
  ) {
    const response = parseAcpRequestUserInputResponsePayload(payload);

    if (!response) {
      return [];
    }

    return [{ type: 'request_user_input_response', response, ts: envelope.ts }];
  }

  return [];
}
