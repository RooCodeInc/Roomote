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
  [FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential]: false,
  [FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials]: false,
  [FAST_AGENT_NATIVE_TOOL_NAMES.addRemoteMcp]: false,
};

export const FAST_AGENT_SUBAGENT_TOOL_FILTER: Record<string, boolean> = {
  '*': true,
  task: false,
  roomote_manage_custom_automations: false,
  roomote_create_custom_skill: false,
  roomote_update_custom_skill: false,
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
  options: {
    surface?: FastAgentSurface;
    serviceCredentialToolsEnabled?: boolean;
    serviceCredentialPrepareEnabled?: boolean;
    addRemoteMcpEnabled?: boolean;
    codeModeIntegrationsEnabled?: boolean;
  } = {},
): Record<string, boolean> {
  return {
    ...FAST_AGENT_NATIVE_TOOL_FILTER,
    [FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential]:
      options.serviceCredentialPrepareEnabled ??
      options.serviceCredentialToolsEnabled === true,
    [FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials]:
      options.serviceCredentialToolsEnabled === true,
    [FAST_AGENT_NATIVE_TOOL_NAMES.addRemoteMcp]:
      options.addRemoteMcpEnabled === true,
    ...(options.surface && options.surface !== 'web'
      ? {
          [FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput]: false,
          [FAST_AGENT_NATIVE_TOOL_NAMES.offerCapability]: false,
        }
      : {}),
    ...(options.codeModeIntegrationsEnabled === true
      ? {
          // OpenCode code mode replaces every mounted MCP tool with the
          // confined `execute` runner; the generic dispatcher must not stay
          // reachable or the model keeps routing calls through it. Discovery
          // (`find_integration_tools`) stays available for the built-in
          // integration catalog and connection statuses.
          execute: true,
          [FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]: false,
        }
      : {}),
    ...Object.fromEntries(integrationIds.map((id) => [`${id}_*`, true])),
  };
}

/**
 * Subagent variant of the tool filter for the code-mode integrations
 * experiment. Helper subagents already see every MCP tool (`*': true`), so
 * OpenCode code mode's `execute` runner is visible to them unchanged; the
 * only adjustment is retiring the generic dispatcher alongside the parent.
 */
export function buildFastAgentSubagentToolFilter(
  options: { codeModeIntegrationsEnabled?: boolean } = {},
): Record<string, boolean> {
  if (options.codeModeIntegrationsEnabled !== true) {
    return FAST_AGENT_SUBAGENT_TOOL_FILTER;
  }
  return {
    ...FAST_AGENT_SUBAGENT_TOOL_FILTER,
    [FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]: false,
  };
}

export function isFastAgentSpillTool(name: FastAgentNativeToolName): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
