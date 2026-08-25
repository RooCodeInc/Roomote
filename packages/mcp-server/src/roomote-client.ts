import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

export interface RoomoteTaskClient {
  callManageTasks(args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export function resolveRoomoteMcpUrl(roomoteUrl: string): URL {
  const url = new URL(roomoteUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  if (!basePath.endsWith('/mcp')) {
    url.pathname = `${basePath}/mcp`;
  } else {
    url.pathname = basePath;
  }
  url.search = '';
  url.hash = '';
  return url;
}

export async function createRoomoteTaskClient(options: {
  roomoteUrl: string;
  accessToken: string;
}): Promise<RoomoteTaskClient> {
  const client = new Client({
    name: 'roomote-stdio-mcp-server',
    version: '0.0.3',
  });
  const transport = new StreamableHTTPClientTransport(
    resolveRoomoteMcpUrl(options.roomoteUrl),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${options.accessToken}` },
      },
    },
  );

  await client.connect(transport);

  return {
    callManageTasks: async (args) =>
      CallToolResultSchema.parse(
        await client.callTool({ name: 'manage_tasks', arguments: args }),
      ),
    close: () => client.close(),
  };
}
