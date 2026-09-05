import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

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
    const integrations = await import('../on-demand-integrations.js');
    const catalog = {
      servers: [
        {
          name: 'example',
          displayName: 'Example',
          url: 'https://example.com/mcp',
        },
      ],
    };
    vi.spyOn(integrations, 'loadOnDemandMcpCatalog').mockReturnValue(catalog);
    const dispatch = vi.fn().mockResolvedValue({ content: [] });
    const call = integrations.callOnDemandIntegrationTool;
    vi.spyOn(integrations, 'callOnDemandIntegrationTool').mockImplementation(
      (servers, params) => call(servers, params, dispatch),
    );
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

      // Compile the complete wire schema so broken recursive refs fail too.
      expect(callTool).toBeDefined();
      const validate = new AjvJsonSchemaValidator().getValidator(
        callTool!.inputSchema,
      );
      const target = { integrationId: 'example', toolName: 'lookup' };
      const nestedArgs = {
        url: 'https://example.com/issues/123',
        organizationSlug: 'example',
        filter: { values: [null, false, 0, '', { nested: [{ value: 'ok' }] }] },
      };
      for (const args of [nestedArgs, {}, null, undefined]) {
        const input = { ...target, ...(args === undefined ? {} : { args }) };
        expect(validate(input).valid).toBe(true);
        const result = await client.callTool({
          name: 'call_integration_tool',
          arguments: input,
        });
        expect(result.isError).not.toBe(true);
        expect(dispatch).toHaveBeenLastCalledWith(
          catalog.servers[0],
          target.toolName,
          args ?? {},
        );
      }

      dispatch.mockClear();
      for (const args of ['not an object', [], 42, true]) {
        const input = { ...target, args };
        expect(validate(input).valid).toBe(false);
        const result = await client.callTool({
          name: 'call_integration_tool',
          arguments: input,
        });
        expect(result.isError).toBe(true);
      }
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await roomoteMcpServer.close();
    }
  });
});
