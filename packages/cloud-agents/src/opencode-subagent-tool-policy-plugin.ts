import { HTTP_INTEGRATIONS_MCP_ID } from '@roomote/types';

import { ROOMOTE_OPENCODE_SUBAGENT_DEFINITIONS } from './opencode-prompt-subagents';

export function createOpenCodeSubagentToolPolicyPluginScript(
  options: {
    brokerNames?: string[];
    memoryNames?: string[];
    otherMcpNames?: string[];
  } = {},
): string {
  const config = JSON.stringify({
    agentPolicies: Object.fromEntries(
      ROOMOTE_OPENCODE_SUBAGENT_DEFINITIONS.flatMap((definition) =>
        definition.toolPolicy
          ? [[definition.name, definition.toolPolicy] as const]
          : [],
      ),
    ),
    brokerNames: options.brokerNames ?? [HTTP_INTEGRATIONS_MCP_ID],
    memoryNames: options.memoryNames ?? ['gbrain', 'supermemory'],
    otherMcpNames: options.otherMcpNames ?? [],
  });

  return `const CONFIG = ${config};
const sessionPolicies = new Map();

function splitMcpTool(tool) {
  for (const name of CONFIG.brokerNames) {
    const prefix = name + '_';
    if (tool.startsWith(prefix)) {
      return { integrationId: '${HTTP_INTEGRATIONS_MCP_ID}', toolName: tool.slice(prefix.length) };
    }
  }
  if (tool.startsWith('roomote_')) {
    return { integrationId: 'roomote', toolName: tool.slice('roomote_'.length) };
  }
  for (const name of CONFIG.memoryNames) {
    const prefix = name + '_';
    if (tool.startsWith(prefix)) return { integrationId: name, toolName: tool.slice(prefix.length) };
  }
  for (const name of CONFIG.otherMcpNames) {
    const prefix = name + '_';
    if (tool.startsWith(prefix)) return { integrationId: name, toolName: tool.slice(prefix.length) };
  }
}

function policyAllows(policy, { integrationId, toolName, args }) {
  const capability = policy.integrations[integrationId]?.tools?.[toolName];
  if (!capability) return policy.allowedMemoryIntegrationIds.includes(integrationId);
  if (capability === true) return true;
  if (capability.actions) return typeof args?.action === 'string' && capability.actions.includes(args.action);
  return typeof args?.method === 'string' && capability.methods.includes(args.method);
}

export const RoomoteOpenCodeSubagentToolPolicy = async () => ({
  'chat.headers': async (input) => {
    sessionPolicies.set(input.sessionID, CONFIG.agentPolicies[input.agent] ?? null);
  },
  event: async ({ event }) => {
    if (event?.type === 'session.deleted') sessionPolicies.delete(event.properties?.info?.id);
  },
  'tool.execute.before': async (input, output) => {
    const recorded = sessionPolicies.has(input.sessionID);
    const policy = sessionPolicies.get(input.sessionID);
    if (input.tool === 'roomote_find_integration_tools' || input.tool === 'roomote_call_integration_tool') {
      output.args._callerToolPolicy = recorded ? (policy?.id ?? 'unrestricted') : 'unknown';
    }
    if (!policy) return;
    const target = splitMcpTool(input.tool);
    if (target && !policyAllows(policy, { ...target, args: output.args })) {
      throw new Error('That tool action is unavailable to this subagent capability policy.');
    }
  },
});
`;
}
