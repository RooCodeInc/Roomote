import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
} from '@roomote/types';

export const FAST_AGENT_NATIVE_TOOL_NAMES = {
  cancelTask: 'cancel_task',
  getChatChannelMessages: CHAT_CHANNEL_MESSAGES_TOOL.name,
  getChatMessageContext: CHAT_MESSAGE_CONTEXT_TOOL.name,
  ignoreEvent: 'ignore_event',
  integrationCall: 'integration_call',
  launchTask: 'launch_task',
  manageTasks: 'manage_tasks',
  retryTaskStart: 'retry_task_start',
  sendChatReaction: 'send_chat_reaction',
  sendChatReply: 'send_chat_reply',
  sendTaskMessage: 'send_task_message',
  spillGrep: 'spill_grep',
  spillRead: 'spill_read',
} as const;

export type FastAgentNativeToolName =
  (typeof FAST_AGENT_NATIVE_TOOL_NAMES)[keyof typeof FAST_AGENT_NATIVE_TOOL_NAMES];

export const FAST_AGENT_NATIVE_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  task: true,
  ...Object.fromEntries(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).map((name) => [
      name,
      name !== FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep &&
        name !== FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
    ]),
  ),
};

export const FAST_AGENT_SUBAGENT_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  [FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall]: true,
  [FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks]: true,
};

export const FAST_AGENT_SPILL_SUBAGENT_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  [FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep]: true,
  [FAST_AGENT_NATIVE_TOOL_NAMES.spillRead]: true,
};

const FAST_AGENT_SUBAGENT_TOOL_NAMES = new Set<FastAgentNativeToolName>([
  FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
  FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks,
]);

export function isFastAgentSubagentTool(
  name: FastAgentNativeToolName,
): boolean {
  return FAST_AGENT_SUBAGENT_TOOL_NAMES.has(name);
}

export function isFastAgentSpillSubagentTool(
  name: FastAgentNativeToolName,
): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
