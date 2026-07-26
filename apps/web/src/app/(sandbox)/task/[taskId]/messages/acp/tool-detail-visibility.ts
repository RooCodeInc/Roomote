import { isInternalDebugToolCallMessage } from '../../message-visibility';
import { isSubagentToolPayload } from './subagent-tool';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

type AcpToolUiMessage = AcpToolCallUiMessage | AcpToolResultUiMessage;

interface ToolDetailVisibilityOptions {
  showSubagentPayload?: boolean;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getSubagentPrompt(msg: AcpToolUiMessage): string | null {
  if (!(msg.kind === 'tool_call' || msg.kind === 'tool_result')) {
    return null;
  }

  if (!isSubagentToolPayload(msg.data)) {
    return null;
  }

  const data = msg.data as unknown as Record<string, unknown>;
  const topLevelPrompt = asNonEmptyString(data.prompt);

  if (topLevelPrompt) {
    return topLevelPrompt;
  }

  const rawInput = data.rawInput;

  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return null;
  }

  return asNonEmptyString((rawInput as Record<string, unknown>).prompt);
}

export function getSubagentLastMessage(msg: AcpToolUiMessage): string | null {
  if (!isSubagentToolPayload(msg.data)) {
    return null;
  }

  const output =
    msg.kind === 'tool_result' ? asNonEmptyString(msg.data.output) : null;

  if (output) {
    return output;
  }

  const activity = (msg.data as unknown as Record<string, unknown>)
    .subagentActivity;

  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
    return null;
  }

  return asNonEmptyString((activity as Record<string, unknown>).lastMessage);
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

    return (
      getSubagentPrompt(msg) === null && getSubagentLastMessage(msg) === null
    );
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
