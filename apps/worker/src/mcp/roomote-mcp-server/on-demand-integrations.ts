import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  limit: z.number().int().positive().max(25).optional(),
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

const FIND_INTEGRATION_TOOLS_DEFAULT_LIMIT = 10;
const ON_DEMAND_MCP_REQUEST_TIMEOUT_MS = 120_000;

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
      timeout: ON_DEMAND_MCP_REQUEST_TIMEOUT_MS,
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
 * Resolve matching tools across the catalog. Exact server and tool names win;
 * otherwise every query term must appear in the tool's name or description.
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
  const limit = params.limit ?? FIND_INTEGRATION_TOOLS_DEFAULT_LIMIT;
  const scoped = params.integrationId
    ? catalog.servers.filter((server) => server.name === params.integrationId)
    : catalog.servers;
  if (params.integrationId && scoped.length === 0) {
    return errorResult(
      `No on-demand integration with id "${params.integrationId}" is attached to this task.`,
      { availableIntegrations: catalog.servers.map((server) => server.name) },
    );
  }
  const terms = (params.query ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  const matches: Array<
    OnDemandMcpTool & { integrationId: string; exact: boolean }
  > = [];
  const unavailable: string[] = [];
  for (const server of scoped) {
    let tools: OnDemandMcpTool[];
    try {
      tools = await listTools(server);
    } catch {
      unavailable.push(server.name);
      continue;
    }
    for (const tool of tools) {
      if (params.toolName && tool.name !== params.toolName) continue;
      const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) {
        continue;
      }
      matches.push({
        ...tool,
        integrationId: server.name,
        exact:
          Boolean(params.toolName) ||
          terms.some((term) => tool.name.toLowerCase() === term),
      });
    }
  }
  matches.sort((left, right) => Number(right.exact) - Number(left.exact));
  return jsonResult({
    success: true,
    tools: matches.slice(0, limit).map(({ exact: _exact, ...tool }) => tool),
    ...(matches.length > limit
      ? {
          guidance:
            'More tools matched than were returned. Narrow the query or pass integrationId or toolName.',
        }
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
      { timeout: ON_DEMAND_MCP_REQUEST_TIMEOUT_MS },
    );
    // Pass the upstream content through unchanged; OpenCode renders it the
    // same way it would a natively mounted MCP result.
    return result as ToolResult;
  });
}
