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

async function createCancellableMcpClient(options: {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) {
  const [{ createMCPClient }, { StreamableHTTPClientTransport }] =
    await Promise.all([
      import('@ai-sdk/mcp'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
  const signal = options.signal;
  signal?.throwIfAborted();
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: options.headers },
    ...(signal
      ? {
          fetch: (url: string | URL, init?: RequestInit) =>
            fetch(url, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            }),
        }
      : {}),
  });

  return createMCPClient({ transport });
}

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** List the tools exposed by a streamable-http MCP server. */
export async function listMcpTools(options: {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<McpToolDefinition[]> {
  const client = await createCancellableMcpClient(options);

  try {
    const definitions = await client.listTools({
      options: { signal: options.signal },
    });
    return definitions.tools.map((definition) => ({
      name: definition.name,
      ...(definition.description
        ? { description: definition.description }
        : {}),
      ...(definition.inputSchema
        ? { inputSchema: definition.inputSchema }
        : {}),
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

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
  signal?: AbortSignal;
}): Promise<unknown | null> {
  const client = await createCancellableMcpClient(options);

  try {
    const definitions = await client.listTools({
      options: { signal: options.signal },
    });
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
      abortSignal: options.signal,
      toolCallId: options.toolCallId ?? `mcp-tool-call:${options.toolName}`,
      messages: [],
    });
    return extractMcpToolResultPayload(result);
  } finally {
    await client.close().catch(() => undefined);
  }
}
