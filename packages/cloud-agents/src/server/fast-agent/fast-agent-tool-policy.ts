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
  manageCustomAutomations: 'manage_custom_automations',
  manageTasks: 'manage_tasks',
  retryTaskStart: 'retry_task_start',
  sendChatReaction: 'send_chat_reaction',
  sendChatReply: 'send_chat_reply',
  sendTaskMessage: 'send_task_message',
} as const;

export type FastAgentNativeToolName =
  (typeof FAST_AGENT_NATIVE_TOOL_NAMES)[keyof typeof FAST_AGENT_NATIVE_TOOL_NAMES];

export const FAST_AGENT_NATIVE_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  task: true,
  ...Object.fromEntries(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).map((name) => [name, true]),
  ),
};

export const FAST_AGENT_SUBAGENT_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  [FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall]: true,
  [FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks]: true,
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
