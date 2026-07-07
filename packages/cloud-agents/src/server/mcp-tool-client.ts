/**
 * Minimal server-side MCP tool-call client for streamable-http MCP servers.
 *
 * Used by the router MCP tool path. The client is created per call, performs
 * the MCP handshake via `@ai-sdk/mcp`, executes a single tool, and always
 * closes the transport.
 */

type McpToolResult = {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

export function extractMcpToolResultPayload(result: unknown): unknown | null {
  if (!result || typeof result !== 'object') {
    return result ?? null;
  }

  const toolResult = result as McpToolResult;

  if (
    'structuredContent' in toolResult &&
    toolResult.structuredContent != null
  ) {
    return toolResult.structuredContent;
  }

  if ('content' in toolResult && Array.isArray(toolResult.content)) {
    const textPart = toolResult.content.find(
      (part: {
        type?: string;
        text?: string;
      }): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    );

    if (!textPart) {
      return toolResult.content;
    }

    try {
      return JSON.parse(textPart.text);
    } catch {
      return textPart.text;
    }
  }

  return result;
}

/**
 * Call a single tool on a streamable-http MCP server.
 *
 * Returns the extracted tool payload, or `null` when the server does not
 * expose the requested tool. Transport and protocol errors are thrown so the
 * caller can decide whether to fail open.
 */
export async function callMcpTool(options: {
  url: string;
  headers?: Record<string, string>;
  toolName: string;
  args?: Record<string, unknown>;
  toolCallId?: string;
}): Promise<unknown | null> {
  const { createMCPClient } = await import('@ai-sdk/mcp');
  const client = await createMCPClient({
    transport: {
      type: 'http',
      url: options.url,
      headers: options.headers,
    },
  });

  try {
    const definitions = await client.listTools();
    const toolDefinition = definitions.tools.find(
      (tool) => tool.name === options.toolName,
    );

    if (!toolDefinition) {
      return null;
    }

    const tools = client.toolsFromDefinitions(definitions);
    const tool = tools[options.toolName];

    if (!tool?.execute) {
      return null;
    }

    const result = await tool.execute(options.args ?? {}, {
      toolCallId: options.toolCallId ?? `mcp-tool-call:${options.toolName}`,
      messages: [],
    });
    return extractMcpToolResultPayload(result);
  } finally {
    await client.close().catch(() => undefined);
  }
}
