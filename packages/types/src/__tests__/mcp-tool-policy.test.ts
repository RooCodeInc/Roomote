import {
  filterMcpToolDefinitions,
  getAllowedIntegrationMcpToolNames,
} from '../mcp-tool-policy';

describe('Better Stack MCP tool policy', () => {
  it('allows current read-only tools and excludes obsolete and mutating names', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('betterstack');

    expect(allowedToolNames).toEqual(
      expect.arrayContaining([
        'incidents',
        'monitor',
        'monitors',
        'query',
        'render_chart',
        'search_documentation',
        'sources',
      ]),
    );
    expect(allowedToolNames).not.toContain('uptime_list_monitors_tool');
    expect(allowedToolNames).not.toContain('telemetry_query');
    expect(allowedToolNames).not.toContain('remove_dashboard');
    expect(allowedToolNames).not.toContain('remove_chart');

    expect(
      filterMcpToolDefinitions(
        [{ name: 'monitors' }, { name: 'query' }, { name: 'remove_dashboard' }],
        { allowedToolNames },
      ),
    ).toEqual([{ name: 'monitors' }, { name: 'query' }]);
  });
});

describe('monday.com MCP tool policy', () => {
  it('allows documented inspection tools and excludes mutating escape hatches', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('monday');

    expect(allowedToolNames).toEqual(
      expect.arrayContaining([
        'get_board_info',
        'get_board_items_page',
        'get_updates',
        'read_docs',
        'search',
      ]),
    );
    expect(allowedToolNames).not.toContain('create_item');
    expect(allowedToolNames).not.toContain('change_item_column_values');
    expect(allowedToolNames).not.toContain('all_monday_api');
  });
});
