import { isNonTranscriptAcpEvent } from './acp-non-transcript';
import type { AcpUiMessage } from './types';

const TOOL_CALLS_DENY_LIST_BY_SOURCE = new Map([
  [
    'browser-mcp',
    new Set([
      'browser_click',
      'browser_fill_form',
      'browser_run_code',
      'browser_wait_for',
      'browser_press_key',
      'browser_navigate',
    ]),
  ],
]);

// Only tools whose call carries no user-visible effect belong here. Outbound
// communication (`send_chat_reply`, `post_to_channel`,
// `send_chat_reaction_emoji`) is a consequential receipt like
// `send_task_message`: for a delegated task reporting to its orchestrator it
// is the entire result, so hiding it left the task transcript blank.
const INTERNAL_DEBUG_TOOL_CALLS_BY_SOURCE = new Map([
  ['roomote', new Set(['find_integration_tools', 'ignore_event'])],
]);

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function getToolSourceAndName(
  msg: AcpUiMessage,
): { source: string; toolName: string } | null {
  if (msg.kind !== 'tool_call' && msg.kind !== 'tool_result') {
    return null;
  }

  const source = msg.data.isMcp
    ? normalizeIdentifier(msg.data.serverName)
    : 'roomote';

  const toolName = msg.data.isMcp
    ? normalizeIdentifier(msg.data.toolName)
    : normalizeIdentifier(msg.data.title);

  if (!source || !toolName) {
    return null;
  }

  return { source, toolName };
}

export function isInternalDebugToolCallMessage(msg: AcpUiMessage): boolean {
  const toolIdentity = getToolSourceAndName(msg);

  if (!toolIdentity) {
    return false;
  }

  return (
    INTERNAL_DEBUG_TOOL_CALLS_BY_SOURCE.get(toolIdentity.source)?.has(
      toolIdentity.toolName,
    ) ?? false
  );
}

function isDeniedToolCallMessage(msg: AcpUiMessage): boolean {
  const toolIdentity = getToolSourceAndName(msg);

  if (!toolIdentity) {
    return false;
  }

  return (
    TOOL_CALLS_DENY_LIST_BY_SOURCE.get(toolIdentity.source)?.has(
      toolIdentity.toolName,
    ) ?? false
  );
}

// Hide server-marked transcript messages and non-transcript runtime updates. The
// "hide the duplicate first user prompt" rule is coordinated by the render
// block builder so hidden bootstrap prompts do not consume that slot.
export function shouldHideAcpMessage(msg: AcpUiMessage): boolean {
  return (
    msg.visibleInTranscript === false ||
    isNonTranscriptAcpEvent(msg.updateType) ||
    isDeniedToolCallMessage(msg)
  );
}
