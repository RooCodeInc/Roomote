import {
  HTTP_INTEGRATIONS_MCP_ID,
  JUDGE_HTTP_INTEGRATION_READ_TOOL_NAMES,
  JUDGE_ROOMOTE_READ_TOOL_NAMES,
  JUDGE_ROOMOTE_TOOL_ACTIONS,
} from '@roomote/types';

export function createOpenCodeJudgeToolPolicyPluginScript(
  options: {
    brokerNames?: string[];
    memoryNames?: string[];
    otherMcpNames?: string[];
  } = {},
): string {
  const policy = JSON.stringify({
    brokerNames: options.brokerNames ?? [HTTP_INTEGRATIONS_MCP_ID],
    memoryNames: options.memoryNames ?? ['gbrain', 'supermemory'],
    otherMcpNames: options.otherMcpNames ?? [],
    httpReadTools: JUDGE_HTTP_INTEGRATION_READ_TOOL_NAMES,
    roomoteReadTools: JUDGE_ROOMOTE_READ_TOOL_NAMES,
    roomoteToolActions: JUDGE_ROOMOTE_TOOL_ACTIONS,
  });

  return `const POLICY = ${policy};
const sessionAgents = new Map();

function splitMcpTool(tool) {
  for (const name of POLICY.brokerNames) {
    const prefix = name + '_';
    if (tool.startsWith(prefix)) {
      return { integrationId: '${HTTP_INTEGRATIONS_MCP_ID}', toolName: tool.slice(prefix.length) };
    }
  }
  if (tool.startsWith('roomote_')) {
    return { integrationId: 'roomote', toolName: tool.slice('roomote_'.length) };
  }
  for (const name of POLICY.memoryNames) {
    const prefix = name + '_';
    if (tool.startsWith(prefix)) return { integrationId: name, toolName: tool.slice(prefix.length) };
  }
  for (const name of POLICY.otherMcpNames) {
    const prefix = name + '_';
    if (tool.startsWith(prefix)) return { integrationId: name, toolName: tool.slice(prefix.length) };
  }
}

function judgeAllows({ integrationId, toolName, args }) {
  if (integrationId === '${HTTP_INTEGRATIONS_MCP_ID}') {
    if (!POLICY.httpReadTools.includes(toolName)) return false;
    return toolName !== 'integration_request' || args?.method === 'GET' || args?.method === 'HEAD';
  }
  if (integrationId === 'roomote') {
    const actions = POLICY.roomoteToolActions[toolName];
    if (actions) return typeof args?.action === 'string' && actions.includes(args.action);
    return POLICY.roomoteReadTools.includes(toolName);
  }
  if (integrationId === 'gbrain') return true;
  return false;
}

export const RoomoteOpenCodeJudgeToolPolicy = async () => ({
  'chat.headers': async (input) => {
    sessionAgents.set(input.sessionID, input.agent);
  },
  event: async ({ event }) => {
    if (event?.type === 'session.deleted') sessionAgents.delete(event.properties?.info?.id);
  },
  'tool.execute.before': async (input, output) => {
    const agent = sessionAgents.get(input.sessionID);
    if (input.tool === 'roomote_find_integration_tools' || input.tool === 'roomote_call_integration_tool') {
      output.args._callerAgent = agent ?? 'unknown';
    }
    if (agent !== 'judge') return;
    const target = splitMcpTool(input.tool);
    if (target && !judgeAllows({ ...target, args: output.args })) {
      throw new Error('That tool action is unavailable to the judge evidence-review role.');
    }
  },
});
`;
}
