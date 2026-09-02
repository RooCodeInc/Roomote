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
 * next live update arrives. Thread-bound rows (`receiverThreadIds` set to the
 * child session) stay visible too: the harness binds every spawn row once the
 * child session is known, and the transcript nests that child's activity under
 * the row, so hiding it would drop the whole subagent from the default view.
 */
export function isSubagentSpawnRowMessage(
  msg: AcpUiMessage,
): msg is AcpToolCallUiMessage | AcpToolResultUiMessage {
  return (
    (msg.kind === 'tool_call' || msg.kind === 'tool_result') &&
    msg.data.kind === 'subagent'
  );
}
