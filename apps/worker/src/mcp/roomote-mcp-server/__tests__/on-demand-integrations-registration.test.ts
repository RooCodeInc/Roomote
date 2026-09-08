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
      registeredTools(withoutCatalog).manage_integration_connection?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    expect(
      registeredTools(withoutCatalog).prepare_integration_connection
        ?.annotations?.readOnlyHint,
    ).toBe(true);
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

  it('exposes integration call args as a required, ref-free object', async () => {
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
            type?: string;
            anyOf?: unknown[];
            additionalProperties?: { anyOf?: Array<{ type?: string }> };
          }
        | undefined;

      // The member server makes optional fields nullable, which would turn
      // `args` into `anyOf [object, null]`; gpt-5.x models then send null on
      // every call. A recursive value schema would serialize to `$ref`s that
      // downstream schema rewrites leave dangling. Neither may come back.
      expect(callTool?.inputSchema.required).toContain('args');
      expect(argsSchema?.type).toBe('object');
      expect(argsSchema?.anyOf).toBeUndefined();
      expect(JSON.stringify(callTool?.inputSchema)).not.toContain('$ref');
      expect(argsSchema?.additionalProperties?.anyOf).toEqual(
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
