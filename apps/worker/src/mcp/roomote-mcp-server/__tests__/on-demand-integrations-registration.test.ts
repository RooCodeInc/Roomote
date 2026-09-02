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
});
