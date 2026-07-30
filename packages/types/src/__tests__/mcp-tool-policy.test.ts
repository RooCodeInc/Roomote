import { getAllowedIntegrationMcpToolNames } from '../mcp-tool-policy';

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
