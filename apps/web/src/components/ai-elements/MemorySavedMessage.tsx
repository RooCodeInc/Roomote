import {
  ACP_ENVELOPE_EVENT_TYPES,
  MEMORY_SAVED_EVENT_TEXT,
  parseMemorySavedEventPayload,
  type MemorySavedEventPayload,
} from '@roomote/types';

import { AcpToolMessage } from '@/app/(sandbox)/task/[taskId]/messages/acp/AcpToolMessage';
import type {
  AcpToolResultUiMessage,
  AcpUiMessage,
} from '@/app/(sandbox)/task/[taskId]/types';

const MEMORY_SAVED_TOOL_NAME = 'memory_saved';

export function MemorySavedMessage({ message }: { message: AcpUiMessage }) {
  if (message.updateType !== ACP_ENVELOPE_EVENT_TYPES.MemorySaved) {
    return null;
  }

  const payload = parseMemorySavedEventPayload(message.data);

  return <AcpToolMessage msg={toMemorySavedToolMessage(message, payload)} />;
}

function toMemorySavedToolMessage(
  message: AcpUiMessage,
  payload: MemorySavedEventPayload | null,
): AcpToolResultUiMessage {
  return {
    id: message.id,
    ts: message.ts,
    role: 'tool',
    partial: message.partial,
    sessionId: message.sessionId,
    updateType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
    kind: 'tool_result',
    text: MEMORY_SAVED_EVENT_TEXT,
    data: {
      toolCallId: message.id,
      kind: 'memory',
      title: MEMORY_SAVED_EVENT_TEXT,
      status: 'completed',
      isExecute: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      exitCode: null,
      output: payload ? JSON.stringify({ memories: payload.memories }) : '',
      toolName: MEMORY_SAVED_TOOL_NAME,
    },
  };
}
