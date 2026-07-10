import type { AcpToolCallPayload, AcpToolResultPayload } from '@roomote/types';

import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from './types';

export function isSubagentToolPayload(
  payload: AcpToolCallPayload | AcpToolResultPayload,
): boolean {
  return payload.kind === 'subagent' || payload.isSubagentSpawn === true;
}

export function isSubagentToolMessage(
  msg: AcpUiMessage,
): msg is AcpToolCallUiMessage | AcpToolResultUiMessage {
  return (
    (msg.kind === 'tool_call' || msg.kind === 'tool_result') &&
    isSubagentToolPayload(msg.data)
  );
}

/**
 * Spawn rows from the harness task tool. Their visibility must key on this
 * stable payload shape, not on the live-only `subagentActivity` field: that
 * field is streamed but never persisted, so any rule that depends on it
 * hides the row again after a transcript rebuild (page refresh) until the
 * next live update arrives. Subagent messages bound to receiver threads are
 * excluded — those surface through the active-subtasks list instead of an
 * inline row.
 */
export function isSubagentSpawnRowMessage(
  msg: AcpUiMessage,
): msg is AcpToolCallUiMessage | AcpToolResultUiMessage {
  if (
    (msg.kind !== 'tool_call' && msg.kind !== 'tool_result') ||
    msg.data.kind !== 'subagent'
  ) {
    return false;
  }

  const receiverThreadIds = msg.data.receiverThreadIds;

  return !Array.isArray(receiverThreadIds) || receiverThreadIds.length === 0;
}
