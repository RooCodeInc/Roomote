import type { CallbackEvent } from '../run-task';

/**
 * Produce a stable deduplication key for a callback event.
 *
 * Multiple CallbackEvents can share the same `ts` (e.g. a `tool_action` and a
 * `todo_update` from one Roomote message). This key lets callers distinguish
 * genuinely distinct events that happen to arrive at the same timestamp.
 */
export function getCallbackEventKey(event: CallbackEvent): string {
  if (event.type === 'turn_started') {
    return event.type;
  }

  if (event.type === 'completion') {
    return `${event.type}:${event.text}`;
  }

  if (event.type === 'reasoning') {
    return `${event.type}:${event.text}`;
  }

  if (event.type === 'text') {
    return `${event.type}:${event.text}`;
  }

  if (event.type === 'followup') {
    return `${event.type}:${event.question}:${JSON.stringify(event.suggestions)}`;
  }

  if (event.type === 'request_user_input') {
    return `${event.type}:${event.request.requestId}`;
  }

  if (event.type === 'request_user_input_response') {
    return `${event.type}:${event.response.requestId}:${event.response.resolution}:${JSON.stringify(event.response.answers)}`;
  }

  if (event.type === 'todo_update') {
    return `${event.type}:${JSON.stringify(event.todos)}`;
  }

  return `${event.type}:${JSON.stringify(event.usage)}`;
}
