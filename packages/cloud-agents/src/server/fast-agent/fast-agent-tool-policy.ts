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
  [FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]: false,
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
  // Discovery remains available for the built-in integration catalog and
  // connection statuses. Connected tools are reached through code mode.
  [FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]: true,
};

export function buildFastAgentCodeModeServerNames(
  integrationIds: string[],
): Map<string, string> {
  const sanitizedNames = integrationIds.map((id) =>
    id.replace(/[^a-zA-Z0-9_-]/gu, '_'),
  );
  const allSanitizedNames = new Set(sanitizedNames);
  const usedNames = new Set<string>();
  const names = new Map<string, string>();

  integrationIds.forEach((id, index) => {
    const baseName = sanitizedNames[index]!;
    let name = baseName;
    if (usedNames.has(name) || sanitizedNames.indexOf(baseName) !== index) {
      let suffix = 1;
      do {
        name = `${baseName}__roomote_${index + suffix}`;
        suffix += 1;
      } while (usedNames.has(name) || allSanitizedNames.has(name));
    }
    usedNames.add(name);
    names.set(id, name);
  });

  return names;
}

/**
 * Deployment MCP servers whose tools are registered with OpenCode directly,
 * so every tool schema rides along in each model request. The Roomote member
 * tools are referenced by name throughout the system prompt and memory recall
 * is a required first call, so both stay native. Every other server is
 * exposed through OpenCode code mode, which keeps a deployment with hundreds
 * of tools from inflating every request.
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
    // OpenCode code mode replaces every mounted MCP tool with the confined
    // `execute` runner. Discovery stays available for the built-in integration
    // catalog and connection statuses.
    execute: true,
    ...Object.fromEntries(integrationIds.map((id) => [`${id}_*`, true])),
  };
}

/**
 * Helper subagents already see every MCP tool (`*': true`), so OpenCode code
 * mode's `execute` runner is visible to them unchanged.
 */
export function buildFastAgentSubagentToolFilter(): Record<string, boolean> {
  return {
    ...FAST_AGENT_SUBAGENT_TOOL_FILTER,
  };
}

export function isFastAgentSpillTool(name: FastAgentNativeToolName): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
