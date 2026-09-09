import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/** A real local MCP endpoint, shared by client and broker regression tests. */
export async function startMcpToolTestServer(
  call: (request: CallToolRequest) => CallToolResult,
  options: { httpFailure?: boolean } = {},
) {
  const mcp = new Server(
    { name: 'mcp-tool-client-test', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'integration_request', inputSchema: { type: 'object' } }],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) =>
    call(request),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  const server = createServer(async (request, response) => {
    if (options.httpFailure) {
      response.writeHead(503).end('Service unavailable (503)');
      return;
    }
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a local TCP listener');
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
