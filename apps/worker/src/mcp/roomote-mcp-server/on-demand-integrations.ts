import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  INTEGRATION_TOOL_LOOKUP_MAX_LIMIT,
  INTEGRATION_TOOL_LOOKUP_TRUNCATED_GUIDANCE,
  matchIntegrationTools,
} from '@roomote/types';
import { z } from 'zod';

import { errorResult, jsonResult } from './tool-result.js';
import type { ToolResult } from './types.js';

/**
 * Deployment MCP servers the worker chose not to mount into OpenCode. Their
 * tool schemas would otherwise ride along in every model request, so the
 * task reaches them through `find_integration_tools` and
 * `call_integration_tool` instead. The worker writes this catalog beside the
 * OpenCode config with the proxy credentials already resolved.
 */
export const ON_DEMAND_MCP_CATALOG_PATH_ENV_VAR =
  'ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH';

const onDemandMcpServerSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const onDemandMcpCatalogSchema = z.object({
  servers: z.array(onDemandMcpServerSchema),
});

type OnDemandMcpServer = z.infer<typeof onDemandMcpServerSchema>;
export type OnDemandMcpCatalog = z.infer<typeof onDemandMcpCatalogSchema>;

type OnDemandMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export const findIntegrationToolsInputSchema = {
  integrationId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Exact on-demand server id from the connected integrations guidance',
    ),
  toolName: z
    .string()
    .min(1)
    .optional()
    .describe("Exact tool name to fetch one tool's input schema"),
  query: z
    .string()
    .min(1)
    .optional()
    .describe('Keywords matched against tool names and descriptions'),
  limit: z
    .number()
    .int()
    .positive()
    .max(INTEGRATION_TOOL_LOOKUP_MAX_LIMIT)
    .optional(),
};

export const callIntegrationToolInputSchema = {
  integrationId: z
    .string()
    .min(1)
    .describe('Exact on-demand server id from find_integration_tools'),
  toolName: z.string().min(1).describe('Exact tool name on that server'),
  args: z
    .record(z.unknown())
    .optional()
    .describe("Tool arguments matching the tool's input schema"),
};

// A tool call may legitimately run long; discovery must not. Lookups fan out
// across the catalog, so the slowest server bounds the whole lookup and has
// to stay well inside the member server's own request timeout.
const ON_DEMAND_MCP_LIST_TIMEOUT_MS = 30_000;
const ON_DEMAND_MCP_CALL_TIMEOUT_MS = 120_000;

export function shouldRegisterOnDemandIntegrationTools(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[ON_DEMAND_MCP_CATALOG_PATH_ENV_VAR]?.trim());
}

export function loadOnDemandMcpCatalog(
  env: NodeJS.ProcessEnv = process.env,
): OnDemandMcpCatalog {
  const path = env[ON_DEMAND_MCP_CATALOG_PATH_ENV_VAR]?.trim();
  if (!path) return { servers: [] };
  return onDemandMcpCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

async function withMcpClient<T>(
  server: OnDemandMcpServer,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers ?? {} },
  });
  const client = new Client({ name: 'roomote-task', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const toolListCache = new Map<string, Promise<OnDemandMcpTool[]>>();

function listOnDemandMcpTools(
  server: OnDemandMcpServer,
): Promise<OnDemandMcpTool[]> {
  const cached = toolListCache.get(server.name);
  if (cached) return cached;
  const listing = withMcpClient(server, async (client) => {
    const result = await client.listTools(undefined, {
      timeout: ON_DEMAND_MCP_LIST_TIMEOUT_MS,
    });
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));
  }).catch((error: unknown) => {
    toolListCache.delete(server.name);
    throw error;
  });
  toolListCache.set(server.name, listing);
  return listing;
}

/**
 * Resolve matching tools across the catalog. Every scoped server is listed at
 * once, so an unreachable server costs the lookup one discovery timeout in
 * total, not one per server; matching and ranking are shared with Fast.
 */
export async function findOnDemandIntegrationTools(
  catalog: OnDemandMcpCatalog,
  params: {
    integrationId?: string;
    toolName?: string;
    query?: string;
    limit?: number;
  },
  listTools: (
    server: OnDemandMcpServer,
  ) => Promise<OnDemandMcpTool[]> = listOnDemandMcpTools,
): Promise<ToolResult> {
  const scoped = params.integrationId
    ? catalog.servers.filter((server) => server.name === params.integrationId)
    : catalog.servers;
  if (params.integrationId && scoped.length === 0) {
    return errorResult(
      `No on-demand integration with id "${params.integrationId}" is attached to this task.`,
      { availableIntegrations: catalog.servers.map((server) => server.name) },
    );
  }
  const listings = await Promise.allSettled(
    scoped.map((server) => listTools(server)),
  );
  const unavailable: string[] = [];
  const candidates = listings.flatMap((listing, index) => {
    const server = scoped[index]!;
    if (listing.status === 'rejected') {
      unavailable.push(server.name);
      return [];
    }
    return listing.value.map((tool) => ({
      integrationId: server.name,
      ...tool,
    }));
  });
  const { tools, truncated } = matchIntegrationTools(candidates, params);
  return jsonResult({
    success: true,
    tools,
    ...(truncated
      ? { guidance: INTEGRATION_TOOL_LOOKUP_TRUNCATED_GUIDANCE }
      : {}),
    ...(unavailable.length > 0 ? { unavailableIntegrations: unavailable } : {}),
  });
}

export async function callOnDemandIntegrationTool(
  catalog: OnDemandMcpCatalog,
  params: {
    integrationId: string;
    toolName: string;
    args?: Record<string, unknown>;
  },
  callTool: (
    server: OnDemandMcpServer,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult> = callOnDemandMcpTool,
): Promise<ToolResult> {
  const server = catalog.servers.find(
    (candidate) => candidate.name === params.integrationId,
  );
  if (!server) {
    return errorResult(
      `No on-demand integration with id "${params.integrationId}" is attached to this task.`,
      { availableIntegrations: catalog.servers.map((entry) => entry.name) },
    );
  }
  try {
    return await callTool(server, params.toolName, params.args ?? {});
  } catch (error) {
    return errorResult(
      `${server.displayName} tool ${params.toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function callOnDemandMcpTool(
  server: OnDemandMcpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return withMcpClient(server, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: ON_DEMAND_MCP_CALL_TIMEOUT_MS },
    );
    // Pass the upstream content through unchanged; OpenCode renders it the
    // same way it would a natively mounted MCP result.
    return result as ToolResult;
  });
}
