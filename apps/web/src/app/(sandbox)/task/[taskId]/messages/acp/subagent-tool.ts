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

export function hasSubagentLiveActivity(msg: AcpUiMessage): boolean {
  const value = (msg.data as unknown as Record<string, unknown>)
    .subagentActivity;

  return (
    isSubagentToolMessage(msg) && value !== null && typeof value === 'object'
  );
}

export function shouldHidePendingSubagentMessage(
  msg: AcpUiMessage,
): msg is AcpToolCallUiMessage | AcpToolResultUiMessage {
  // Spawns that carry live activity from the worker render as inline tool
  // rows; only activity-less pending spawns (old workers) stay hidden.
  if (hasSubagentLiveActivity(msg)) {
    return false;
  }

  return (
    isSubagentToolMessage(msg) &&
    (msg.kind === 'tool_call' ||
      msg.partial === true ||
      msg.data.status === 'in_progress')
  );
}
