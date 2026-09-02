import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  callOnDemandIntegrationTool,
  findOnDemandIntegrationTools,
  loadOnDemandMcpCatalog,
  ON_DEMAND_MCP_CATALOG_PATH_ENV_VAR,
  shouldRegisterOnDemandIntegrationTools,
  type OnDemandMcpCatalog,
} from '../on-demand-integrations.js';

const catalog: OnDemandMcpCatalog = {
  servers: [
    {
      name: 'github',
      displayName: 'GitHub',
      description: 'Repository access',
      url: 'https://api.example.com/api/mcp/github',
      headers: { Authorization: 'Bearer run-token' },
    },
    {
      name: 'linear',
      displayName: 'Linear',
      url: 'https://api.example.com/api/mcp/linear',
    },
  ],
};

const inputSchema = {
  type: 'object',
  properties: { query: { type: 'string' } },
};
const listTools = vi.fn(async (server: { name: string }) =>
  server.name === 'github'
    ? [
        { name: 'search_code', description: 'Search code', inputSchema },
        { name: 'list_issues', description: 'List issues', inputSchema },
      ]
    : [{ name: 'search_issues', description: 'Search issues', inputSchema }],
);

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('on-demand integration tools', () => {
  it('registers only when the worker wrote a catalog', () => {
    expect(shouldRegisterOnDemandIntegrationTools({})).toBe(false);
    expect(
      shouldRegisterOnDemandIntegrationTools({
        [ON_DEMAND_MCP_CATALOG_PATH_ENV_VAR]: '/tmp/catalog.json',
      }),
    ).toBe(true);
  });

  it('loads and validates the catalog the worker wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-'));
    const path = join(dir, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog));
    expect(
      loadOnDemandMcpCatalog({ [ON_DEMAND_MCP_CATALOG_PATH_ENV_VAR]: path }),
    ).toEqual(catalog);
    expect(loadOnDemandMcpCatalog({})).toEqual({ servers: [] });
  });

  it('finds tools by keywords across servers with schemas attached', async () => {
    const result = parse(
      await findOnDemandIntegrationTools(
        catalog,
        { query: 'search' },
        listTools,
      ),
    );
    expect(result.success).toBe(true);
    expect(result.tools).toEqual([
      {
        integrationId: 'github',
        name: 'search_code',
        description: 'Search code',
        inputSchema,
      },
      {
        integrationId: 'linear',
        name: 'search_issues',
        description: 'Search issues',
        inputSchema,
      },
    ]);
  });

  it('scopes lookups to a server and reports unknown ids', async () => {
    const scoped = parse(
      await findOnDemandIntegrationTools(
        catalog,
        { integrationId: 'github', toolName: 'list_issues' },
        listTools,
      ),
    );
    expect(scoped.tools).toEqual([
      expect.objectContaining({ integrationId: 'github', name: 'list_issues' }),
    ]);
    const missing = parse(
      await findOnDemandIntegrationTools(
        catalog,
        { integrationId: 'missing' },
        listTools,
      ),
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('"missing"');
    expect(missing.availableIntegrations).toEqual(['github', 'linear']);
  });

  it('keeps searching when one server cannot list its tools', async () => {
    const flaky = vi.fn(async (server: { name: string }) => {
      if (server.name === 'linear') throw new Error('upstream down');
      return listTools(server);
    });
    const result = parse(
      await findOnDemandIntegrationTools(catalog, { query: 'issues' }, flaky),
    );
    expect(result.tools).toEqual([
      expect.objectContaining({ integrationId: 'github', name: 'list_issues' }),
    ]);
    expect(result.unavailableIntegrations).toEqual(['linear']);
  });

  it('routes calls to the named server with its resolved credentials', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"matches":[]}' }],
    }));
    const result = await callOnDemandIntegrationTool(
      catalog,
      {
        integrationId: 'github',
        toolName: 'search_code',
        args: { query: 'fast' },
      },
      callTool,
    );
    expect(result.content[0]?.text).toBe('{"matches":[]}');
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'github',
        headers: { Authorization: 'Bearer run-token' },
      }),
      'search_code',
      { query: 'fast' },
    );

    const missing = parse(
      await callOnDemandIntegrationTool(
        catalog,
        { integrationId: 'missing', toolName: 'x' },
        callTool,
      ),
    );
    expect(missing.success).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
