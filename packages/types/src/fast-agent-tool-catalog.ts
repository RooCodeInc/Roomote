import { ACP_TOOL_KINDS, type KnownAcpToolKind } from './acp';

/**
 * Native tools exposed by Fast sessions. Keep this catalog in the shared
 * contract so runtime policy and transcript fixtures describe the same set.
 */
export const FAST_AGENT_NATIVE_TOOL_NAMES = {
  callIntegrationTool: 'call_integration_tool',
  cancelTask: 'cancel_task',
  createArtifact: 'create_artifact',
  findIntegrationTools: 'find_integration_tools',
  ignoreEvent: 'ignore_event',
  inspectImages: 'inspect_images',
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
  requestUserInput: 'request_user_input',
  reviewPullRequest: 'review_pull_request',
} as const;

export type FastAgentNativeToolName =
  (typeof FAST_AGENT_NATIVE_TOOL_NAMES)[keyof typeof FAST_AGENT_NATIVE_TOOL_NAMES];

export const FAST_AGENT_NATIVE_TOOL_CATALOG = [
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
    kind: ACP_TOOL_KINDS.mcp,
  },
  { name: FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask, kind: ACP_TOOL_KINDS.task },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.reviewPullRequest,
    kind: ACP_TOOL_KINDS.task,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.createArtifact,
    kind: ACP_TOOL_KINDS.artifact,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools,
    kind: ACP_TOOL_KINDS.search,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
    kind: ACP_TOOL_KINDS.communication,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.inspectImages,
    kind: ACP_TOOL_KINDS.read,
  },
  { name: FAST_AGENT_NATIVE_TOOL_NAMES.launchTask, kind: ACP_TOOL_KINDS.task },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart,
    kind: ACP_TOOL_KINDS.task,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.saveMemory,
    kind: ACP_TOOL_KINDS.memory,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction,
    kind: ACP_TOOL_KINDS.communication,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply,
    kind: ACP_TOOL_KINDS.communication,
  },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage,
    kind: ACP_TOOL_KINDS.task,
  },
  { name: FAST_AGENT_NATIVE_TOOL_NAMES.listSkills, kind: ACP_TOOL_KINDS.list },
  { name: FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill, kind: ACP_TOOL_KINDS.read },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.showWidget,
    kind: ACP_TOOL_KINDS.widget,
  },
  { name: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep, kind: ACP_TOOL_KINDS.search },
  { name: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, kind: ACP_TOOL_KINDS.read },
  {
    name: FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput,
    kind: ACP_TOOL_KINDS.communication,
  },
] as const satisfies readonly {
  name: FastAgentNativeToolName;
  kind: KnownAcpToolKind;
}[];

export function getFastAgentNativeAcpKind(
  name: FastAgentNativeToolName,
): KnownAcpToolKind {
  return (
    FAST_AGENT_NATIVE_TOOL_CATALOG.find((tool) => tool.name === name)?.kind ??
    ACP_TOOL_KINDS.tool
  );
}
