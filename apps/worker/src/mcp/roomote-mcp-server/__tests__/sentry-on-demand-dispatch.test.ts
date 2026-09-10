import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ToolResult } from '../types.js';

it('preserves required Sentry scope from discovery through registered MCP dispatch', async () => {
  const originalCatalogPath = process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH;
  process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH = '/unused/catalog.json';
  vi.resetModules();
  const integration = await import('../on-demand-integrations.js');
  const { findOnDemandIntegrationTools, callOnDemandIntegrationTool } =
    integration;
  const catalog = {
    servers: [
      { name: 'sentry', displayName: 'Sentry', url: 'https://example.com/mcp' },
    ],
  };
  const search = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: '{"issues":[]}' }],
  }));
  const upstream = new McpServer({ name: 'sentry-fixture', version: '1.0.0' });
  upstream.registerTool(
    'search_issues',
    {
      inputSchema: {
        organizationSlug: z.string().min(1),
        query: z.string(),
        projectSlugOrId: z.string().nullable().optional(),
      },
    },
    search,
  );
  const upstreamClient = new Client({
    name: 'upstream-test',
    version: '1.0.0',
  });
  const [upstreamClientTransport, upstreamServerTransport] =
    InMemoryTransport.createLinkedPair();
  await upstream.connect(upstreamServerTransport);
  await upstreamClient.connect(upstreamClientTransport);

  // Replace only catalog/transport boundaries; retain discovery, routing,
  // member registration, wire validation, and the upstream required schema.
  vi.spyOn(integration, 'loadOnDemandMcpCatalog').mockReturnValue(catalog);
  vi.spyOn(integration, 'findOnDemandIntegrationTools').mockImplementation(
    (servers, params) =>
      findOnDemandIntegrationTools(
        servers,
        params,
        async () => (await upstreamClient.listTools()).tools,
      ),
  );
  vi.spyOn(integration, 'callOnDemandIntegrationTool').mockImplementation(
    (servers, params) =>
      callOnDemandIntegrationTool(
        servers,
        params,
        async (_server, name, args) =>
          (await upstreamClient.callTool({
            name,
            arguments: args,
          })) as ToolResult,
      ),
  );
  const { roomoteMcpServer } = await import('../index.js');
  const client = new Client({ name: 'member-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await roomoteMcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      'call_integration_tool',
    );
    const discovered = (await client.callTool({
      name: 'find_integration_tools',
      arguments: { integrationId: 'sentry', toolName: 'search_issues' },
    })) as ToolResult;
    const {
      tools: [tool],
    } = JSON.parse(discovered.content[0]!.text!);
    expect(tool.inputSchema.required).toContain('organizationSlug');
    const args = {
      organizationSlug: 'example-org',
      query: 'lastSeen:-24h',
      projectSlugOrId: 'example-project',
    };
    const call = {
      integrationId: tool.integrationId,
      toolName: tool.name,
      args,
    };
    const result = await client.callTool({
      name: 'call_integration_tool',
      arguments: call,
    });
    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalledWith(args, expect.anything());

    for (const invalidArgs of [
      { query: args.query },
      { ...args, organizationSlug: null },
    ]) {
      const invalid = await client.callTool({
        name: 'call_integration_tool',
        arguments: { ...call, args: invalidArgs },
      });
      expect(invalid.isError).toBe(true);
    }
    const unavailable = (await client.callTool({
      name: 'call_integration_tool',
      arguments: { ...call, integrationId: 'not-attached' },
    })) as ToolResult;
    expect(JSON.parse(unavailable.content[0]!.text!)).toMatchObject({
      success: false,
      availableIntegrations: ['sentry'],
    });
    expect(search).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await roomoteMcpServer.close();
    await upstreamClient.close();
    await upstream.close();
    vi.restoreAllMocks();
    if (originalCatalogPath === undefined)
      delete process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH;
    else process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH = originalCatalogPath;
  }
});
