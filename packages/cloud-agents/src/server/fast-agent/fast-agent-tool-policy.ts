import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
  type FastAgentSurface,
  isMemoryMcpServer,
  ROOMOTE_MCP_ID,
  type FastAgentNativeToolName,
} from '@roomote/types';

export {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
  type FastAgentNativeToolName,
};

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
  // Subagents reach on-demand deployment MCP servers the same way the parent
  // does; these two are the only Fast tools they share.
  [FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]: true,
  [FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]: true,
};

/**
 * Deployment MCP servers whose tools are registered with OpenCode directly,
 * so every tool schema rides along in each model request. The Roomote member
 * tools are referenced by name throughout the system prompt and memory recall
 * is a required first call, so both stay native. Every other server is
 * exposed on demand through `find_integration_tools` and
 * `call_integration_tool`, which keeps a deployment with hundreds of tools
 * from inflating every request.
 */
export function isFastAgentNativeIntegration(integrationId: string): boolean {
  return integrationId === ROOMOTE_MCP_ID || isMemoryMcpServer(integrationId);
}

export function buildFastAgentToolFilter(
  integrationIds: string[],
  options: { surface?: FastAgentSurface } = {},
): Record<string, boolean> {
  return {
    ...FAST_AGENT_NATIVE_TOOL_FILTER,
    ...(options.surface && options.surface !== 'web'
      ? { [FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput]: false }
      : {}),
    ...Object.fromEntries(integrationIds.map((id) => [`${id}_*`, true])),
  };
}

export function isFastAgentSpillTool(name: FastAgentNativeToolName): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
