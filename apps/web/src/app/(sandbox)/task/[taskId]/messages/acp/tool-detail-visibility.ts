import { isInternalDebugToolCallMessage } from '../../message-visibility';
import { isSubagentToolPayload } from './subagent-tool';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

type AcpToolUiMessage = AcpToolCallUiMessage | AcpToolResultUiMessage;

interface ToolDetailVisibilityOptions {
  showSubagentPayload?: boolean;
}

export function hidesExpandedToolResult(
  msg: AcpToolUiMessage,
  options?: ToolDetailVisibilityOptions,
): boolean {
  const data = msg.data as unknown as Record<string, unknown>;
  const hideSubagentPayload =
    isSubagentToolPayload(msg.data) && options?.showSubagentPayload !== true;

  return (
    hideSubagentPayload ||
    isInternalDebugToolCallMessage(msg) ||
    msg.data.kind === 'read' ||
    msg.data.kind === 'execute' ||
    msg.data.kind === 'execute_command' ||
    data.isRead === true ||
    data.isExecute === true
  );
}
