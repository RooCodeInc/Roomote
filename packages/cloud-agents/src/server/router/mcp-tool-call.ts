import type { RoutingContext } from './types';
import type { RouterMcpServerId } from './mcp-policy';
import { resolveConfiguredRouterMcpServers } from './mcp-server-discovery';
import { callMcpTool } from '../mcp-tool-client';

export async function callRouterMcpTool(options: {
  context: RoutingContext;
  serverId: RouterMcpServerId;
  toolName: string;
  args?: Record<string, unknown>;
}): Promise<unknown | null> {
  const servers = await resolveConfiguredRouterMcpServers(options.context);
  const server = servers.find((candidate) => candidate.id === options.serverId);

  if (!server) {
    return null;
  }

  return callMcpTool({
    url: server.url,
    headers: server.headers,
    toolName: options.toolName,
    args: options.args,
    toolCallId: `router-mcp:${options.serverId}:${options.toolName}`,
  });
}
