import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ToolResult } from '../types.js';

it('preserves synthetic Better Stack discovery schemas and arguments through registered MCP dispatch', async () => {
  const originalCatalogPath = process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH;
  process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH = '/unused/catalog.json';
  vi.resetModules();
  const integration = await import('../on-demand-integrations.js');
  const { findOnDemandIntegrationTools, callOnDemandIntegrationTool } =
    integration;
  const catalog = {
    servers: [
      {
        name: 'betterstack',
        displayName: 'Better Stack',
        url: 'https://example.com/mcp',
      },
    ],
  };
  // Synthetic transport fixtures, not verification of the live provider contract.
  const schemas = {
    sources: {
      name: z.string().optional(),
      page: z.number().int().optional(),
      per_page: z.number().int().optional(),
    },
    source: { id: z.number().int() },
    query: {
      query: z.string(),
      source_id: z.number(),
      table: z.string(),
      host: z.string().optional(),
    },
  };
  const respond = async () => ({
    content: [{ type: 'text' as const, text: '{"synthetic":true}' }],
  });
  const handlers = {
    sources: vi.fn(respond),
    source: vi.fn(respond),
    query: vi.fn(respond),
  };
  const upstream = new McpServer({
    name: 'synthetic-betterstack-fixture',
    version: '1.0.0',
  });
  upstream.registerTool(
    'sources',
    { inputSchema: schemas.sources },
    handlers.sources,
  );
  upstream.registerTool(
    'source',
    { inputSchema: schemas.source },
    handlers.source,
  );
  const queryTool = upstream.registerTool(
    'query',
    { inputSchema: schemas.query },
    handlers.query,
  );
  const upstreamClient = new Client({
    name: 'upstream-test',
    version: '1.0.0',
  });
  const [upstreamClientTransport, upstreamServerTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'member-test', version: '1.0.0' });
  let memberServer: McpServer | undefined;
  try {
    await upstream.connect(upstreamServerTransport);
    await upstreamClient.connect(upstreamClientTransport);
    // Replace only catalog/transport boundaries, as in the Sentry regression.
    vi.spyOn(integration, 'loadOnDemandMcpCatalog').mockReturnValue(catalog);
    const listTools = vi.fn(
      async () => (await upstreamClient.listTools()).tools,
    );
    const callTool = vi.fn(
      async (_server, name, args) =>
        (await upstreamClient.callTool({
          name,
          arguments: args,
        })) as ToolResult,
    );
    vi.spyOn(integration, 'findOnDemandIntegrationTools').mockImplementation(
      (servers, params) =>
        findOnDemandIntegrationTools(servers, params, listTools),
    );
    vi.spyOn(integration, 'callOnDemandIntegrationTool').mockImplementation(
      (servers, params) =>
        callOnDemandIntegrationTool(servers, params, callTool),
    );
    const { roomoteMcpServer } = await import('../index.js');
    memberServer = roomoteMcpServer;
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await memberServer.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'find_integration_tools',
        'call_integration_tool',
      ]),
    );
    for (const name of ['sources', 'source', 'query'] as const) {
      const discovered = (await client.callTool({
        name: 'find_integration_tools',
        arguments: {
          integrationId: 'betterstack',
          toolName: name,
          query: 'source table metadata',
        },
      })) as ToolResult;
      expect(JSON.parse(discovered.content[0]!.text!)).toMatchObject({
        success: true,
        tools: [{ integrationId: 'betterstack', name }],
      });
      const { tools } = JSON.parse(discovered.content[0]!.text!);
      expect(tools).toHaveLength(1);
      expect(tools[0].inputSchema).toEqual(
        (await upstreamClient.listTools()).tools.find(
          (tool) => tool.name === name,
        )!.inputSchema,
      );
      expect(tools[0].inputSchema.required ?? []).toEqual(
        name === 'sources'
          ? []
          : name === 'source'
            ? ['id']
            : ['query', 'source_id', 'table'],
      );
      expect(JSON.stringify(tools[0].inputSchema)).not.toContain('"default":');
    }

    const queryArgs = {
      query: 'SELECT count(*) FROM synthetic_logs',
      source_id: 42,
      table: 'synthetic_logs',
    };
    const validCalls = [
      { name: 'sources' as const, args: {} },
      {
        name: 'sources' as const,
        args: { name: 'synthetic-source', page: 2, per_page: 7 },
      },
      { name: 'source' as const, args: { id: 42 } },
      { name: 'query' as const, args: queryArgs },
      {
        name: 'query' as const,
        args: { ...queryArgs, host: 'synthetic.example.com' },
      },
    ];
    for (const { name, args } of validCalls) {
      const result = await client.callTool({
        name: 'call_integration_tool',
        arguments: { integrationId: 'betterstack', toolName: name, args },
      });
      expect(result.isError).not.toBe(true);
      expect(callTool).toHaveBeenLastCalledWith(catalog.servers[0], name, args);
      expect(handlers[name]).toHaveBeenLastCalledWith(args, expect.anything());
    }
    for (const [toolName, args] of [
      ['source', {}],
      ['source', { id: 1.5 }],
      ['source', { id: '42' }],
      ['query', { source_id: 42, table: 'synthetic_logs' }],
      ['query', { query: queryArgs.query, table: 'synthetic_logs' }],
      ['query', { query: queryArgs.query, source_id: 42 }],
      ['query', { ...queryArgs, source_id: '42' }],
      ['query', { ...queryArgs, query: null }],
      ['query', { ...queryArgs, table: 42 }],
      ['query', { ...queryArgs, host: null }],
      ['unknown_tool', {}],
    ]) {
      const invalid = await client.callTool({
        name: 'call_integration_tool',
        arguments: { integrationId: 'betterstack', toolName, args },
      });
      expect(invalid.isError).toBe(true);
    }
    listTools.mockClear();
    callTool.mockClear();
    for (const name of ['find_integration_tools', 'call_integration_tool']) {
      const unavailable = (await client.callTool({
        name,
        arguments: {
          integrationId: 'not-attached',
          toolName: 'sources',
          args: {},
        },
      })) as ToolResult;
      expect(JSON.parse(unavailable.content[0]!.text!)).toMatchObject({
        success: false,
        availableIntegrations: ['betterstack'],
      });
    }
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    queryTool.disable();
    const disabledDiscovery = (await client.callTool({
      name: 'find_integration_tools',
      arguments: { integrationId: 'betterstack', toolName: 'query' },
    })) as ToolResult;
    expect(JSON.parse(disabledDiscovery.content[0]!.text!)).toMatchObject({
      tools: [],
    });
    const disabled = await client.callTool({
      name: 'call_integration_tool',
      arguments: {
        integrationId: 'betterstack',
        toolName: 'query',
        args: queryArgs,
      },
    });
    expect(disabled.isError).toBe(true);
    expect(handlers.sources).toHaveBeenCalledTimes(2);
    expect(handlers.source).toHaveBeenCalledTimes(1);
    expect(handlers.query).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await memberServer?.close();
    await upstreamClient.close();
    await upstream.close();
    vi.restoreAllMocks();
    if (originalCatalogPath === undefined)
      delete process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH;
    else process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH = originalCatalogPath;
  }
});
