import { ACP_TOOL_KINDS, type KnownAcpToolKind } from '@roomote/types';

export const FAST_AGENT_NATIVE_TOOL_NAMES = {
  cancelTask: 'cancel_task',
  ignoreEvent: 'ignore_event',
  launchTask: 'launch_task',
  retryTaskStart: 'retry_task_start',
  saveMemory: 'save_memory',
  sendChatReaction: 'send_chat_reaction',
  sendChatReply: 'send_chat_reply',
  sendTaskMessage: 'send_task_message',
  listSkills: 'list_skills',
  loadSkill: 'load_skill',
  showWidget: 'show_widget',
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

export function getFastAgentNativeAcpKind(
  name: FastAgentNativeToolName,
): KnownAcpToolKind {
  if (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill
  )
    return ACP_TOOL_KINDS.read;
  if (name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep)
    return ACP_TOOL_KINDS.search;
  if (name === FAST_AGENT_NATIVE_TOOL_NAMES.listSkills)
    return ACP_TOOL_KINDS.list;
  if (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.launchTask ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage
  )
    return ACP_TOOL_KINDS.task;
  if (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent
  )
    return ACP_TOOL_KINDS.communication;
  if (name === FAST_AGENT_NATIVE_TOOL_NAMES.saveMemory)
    return ACP_TOOL_KINDS.memory;
  if (name === FAST_AGENT_NATIVE_TOOL_NAMES.showWidget)
    return ACP_TOOL_KINDS.widget;
  return ACP_TOOL_KINDS.tool;
}
