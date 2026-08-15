import {
  filterMcpToolDefinitions,
  getAllowedIntegrationMcpToolNames,
  getMcpIntegrationToolAccessModeConfig,
  NOTION_READ_ONLY_TOOL_NAMES,
  resolveMcpIntegrationToolAccessMode,
} from '../mcp-tool-policy';

describe('Notion MCP tool access modes', () => {
  it('defaults missing and invalid values to a fail-closed read-only policy', () => {
    expect(resolveMcpIntegrationToolAccessMode('notion', null)).toBe(
      'read_only',
    );
    expect(resolveMcpIntegrationToolAccessMode('notion', 'unexpected')).toBe(
      'read_only',
    );
    expect(getAllowedIntegrationMcpToolNames('notion')).toEqual(
      NOTION_READ_ONLY_TOOL_NAMES,
    );
    expect(getAllowedIntegrationMcpToolNames('notion', 'unexpected')).toEqual(
      NOTION_READ_ONLY_TOOL_NAMES,
    );
  });

  it('allows only documented non-mutating tools in read-only mode', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames(
      'notion',
      'read_only',
    );

    expect(allowedToolNames).toEqual(
      expect.arrayContaining([
        'notion-search',
        'notion-fetch',
        'notion-query-data-sources',
        'notion-get-comments',
      ]),
    );
    expect(allowedToolNames).not.toContain('notion-create-pages');
    expect(allowedToolNames).not.toContain('notion-update-page');
    expect(allowedToolNames).not.toContain('notion-create-comment');
    expect(allowedToolNames).not.toContain('notion-append-blocks');
  });

  it('removes the allowlist only after read-write is explicitly selected', () => {
    expect(
      getAllowedIntegrationMcpToolNames('notion', 'read_write'),
    ).toBeUndefined();
    expect(getMcpIntegrationToolAccessModeConfig('notion')).toMatchObject({
      defaultMode: 'read_only',
      supportedModes: ['read_only', 'read_write'],
    });
    expect(getMcpIntegrationToolAccessModeConfig('sentry')).toBeUndefined();
  });
});

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

describe('X MCP tool policy', () => {
  it('matches the snake_case tool names the hosted X server advertises', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('x');

    // The hosted X MCP server names tools in snake_case, not the camelCase
    // OpenAPI operationIds. These are real names observed from tools/list.
    expect(allowedToolNames).toEqual(
      expect.arrayContaining([
        'search_posts_all',
        'search_posts_recent',
        'get_posts_by_id',
        'get_users_by_username',
        'search_users',
        'get_trends_by_woeid',
        'get_news',
      ]),
    );
    // Guard against a regression back to camelCase operationIds, which would
    // silently filter out every upstream tool.
    expect(allowedToolNames).not.toContain('searchPostsAll');
    expect(allowedToolNames).not.toContain('getUsersByUsername');
  });

  it('excludes mutating and user-context tools the server also exposes', () => {
    const allowedToolNames = getAllowedIntegrationMcpToolNames('x');

    for (const excluded of [
      'create_users_bookmark',
      'delete_users_bookmark',
      'get_users_bookmarks',
      'get_users_mentions',
      'get_users_timeline',
    ]) {
      expect(allowedToolNames).not.toContain(excluded);
    }

    expect(
      filterMcpToolDefinitions(
        [
          { name: 'search_posts_all' },
          { name: 'get_users_by_username' },
          { name: 'create_users_bookmark' },
          { name: 'get_users_timeline' },
        ],
        { allowedToolNames },
      ),
    ).toEqual([
      { name: 'search_posts_all' },
      { name: 'get_users_by_username' },
    ]);
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
