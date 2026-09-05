import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('roomote MCP on-demand integration tool registration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function registeredTools(server: unknown) {
    return (
      server as {
        _registeredTools: Record<
          string,
          { annotations?: { readOnlyHint?: boolean } }
        >;
      }
    )._registeredTools;
  }

  it('registers the lookup and call tools only when a catalog is attached', async () => {
    const { roomoteMcpServer: withoutCatalog } = await import('../index.js');
    expect(
      registeredTools(withoutCatalog).find_integration_tools,
    ).toBeUndefined();
    expect(
      registeredTools(withoutCatalog).call_integration_tool,
    ).toBeUndefined();

    vi.resetModules();
    process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH = '/tmp/catalog.json';
    const { roomoteMcpServer } = await import('../index.js');
    const tools = registeredTools(roomoteMcpServer);
    expect(tools.find_integration_tools?.annotations?.readOnlyHint).toBe(true);
    expect(tools.call_integration_tool).toBeDefined();
  });

  it('exposes integration call args as an object with arbitrary JSON values', async () => {
    process.env.ROOMOTE_ON_DEMAND_MCP_CATALOG_PATH = '/tmp/catalog.json';
    const { roomoteMcpServer } = await import('../index.js');
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-test', version: '1.0.0' });

    await roomoteMcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const callTool = tools.find(
        (tool) => tool.name === 'call_integration_tool',
      );
      const argsSchema = callTool?.inputSchema.properties?.args as
        | {
            anyOf?: Array<{
              type?: string;
              additionalProperties?: { anyOf?: Array<{ type?: string }> };
            }>;
          }
        | undefined;
      const objectSchema = argsSchema?.anyOf?.find(
        (schema) => schema.type === 'object',
      );

      expect(objectSchema?.additionalProperties?.anyOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'string' }),
          expect.objectContaining({ type: 'object' }),
          expect.objectContaining({ type: 'array' }),
        ]),
      );
    } finally {
      await client.close();
      await roomoteMcpServer.close();
    }
  });
});
