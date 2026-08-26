export const FAST_AGENT_NATIVE_TOOL_NAMES = {
  cancelTask: 'cancel_task',
  ignoreEvent: 'ignore_event',
  launchTask: 'launch_task',
  retryTaskStart: 'retry_task_start',
  saveMemory: 'save_memory',
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
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).map((name) => [name, true]),
  ),
};

export const FAST_AGENT_SUBAGENT_TOOL_FILTER: Record<string, boolean> = {
  '*': true,
  task: false,
  roomote_manage_custom_automations: false,
  ...Object.fromEntries(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).map((name) => [name, false]),
  ),
};

export function buildFastAgentToolFilter(
  integrationIds: string[],
): Record<string, boolean> {
  return {
    ...FAST_AGENT_NATIVE_TOOL_FILTER,
    ...Object.fromEntries(integrationIds.map((id) => [`${id}_*`, true])),
  };
}

export function isFastAgentSpillTool(name: FastAgentNativeToolName): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
