import { isInternalDebugToolCallMessage } from '../../message-visibility';
import { isSubagentToolPayload } from './subagent-tool';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

type AcpToolUiMessage = AcpToolCallUiMessage | AcpToolResultUiMessage;

interface ToolDetailVisibilityOptions {
  showSubagentPayload?: boolean;
}

export function getSubagentPrompt(msg: AcpToolUiMessage): string | null {
  if (!(msg.kind === 'tool_call' || msg.kind === 'tool_result')) {
    return null;
  }

  if (!isSubagentToolPayload(msg.data)) {
    return null;
  }

  const prompt = msg.data.prompt;

  if (typeof prompt !== 'string') {
    return null;
  }

  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function hidesExpandedToolResult(
  msg: AcpToolUiMessage,
  options?: ToolDetailVisibilityOptions,
): boolean {
  const data = msg.data as unknown as Record<string, unknown>;

  if (isSubagentToolPayload(msg.data)) {
    if (options?.showSubagentPayload === true) {
      return false;
    }

    return getSubagentPrompt(msg) === null;
  }

  return (
    isInternalDebugToolCallMessage(msg) ||
    msg.data.kind === 'read' ||
    msg.data.kind === 'execute' ||
    msg.data.kind === 'execute_command' ||
    data.isRead === true ||
    data.isExecute === true
  );
}
