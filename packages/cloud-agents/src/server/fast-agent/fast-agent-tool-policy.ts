export const FAST_AGENT_NATIVE_TOOL_NAMES = {
  cancelTask: 'cancel_task',
  ignoreEvent: 'ignore_event',
  integrationCall: 'integration_call',
  launchTask: 'launch_task',
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
};

const FAST_AGENT_SUBAGENT_TOOL_NAMES = new Set<FastAgentNativeToolName>([
  FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
]);

export function isFastAgentSubagentTool(
  name: FastAgentNativeToolName,
): boolean {
  return FAST_AGENT_SUBAGENT_TOOL_NAMES.has(name);
}
