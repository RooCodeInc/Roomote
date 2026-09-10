import {
  INTEGRATION_TOOL_LOOKUP_DEFAULT_LIMIT,
  matchIntegrationTools,
} from '../integration-tool-lookup';

const candidates = [
  { integrationId: 'github', name: 'search_code', description: 'Search code' },
  { integrationId: 'github', name: 'list_issues', description: 'List issues' },
  { integrationId: 'linear', name: 'issues', description: 'Search issues' },
];

describe('matchIntegrationTools', () => {
  it('requires every query term and ranks exact name matches first', () => {
    expect(
      matchIntegrationTools(candidates, { query: 'issues' }).tools.map(
        (tool) => `${tool.integrationId}/${tool.name}`,
      ),
    ).toEqual(['linear/issues', 'github/list_issues']);
    expect(
      matchIntegrationTools(candidates, { query: 'search issues' }).tools,
    ).toEqual([candidates[2]]);
  });

  it('scopes by server and exact tool name', () => {
    expect(
      matchIntegrationTools(candidates, { integrationId: 'github' }).tools,
    ).toEqual([candidates[0], candidates[1]]);
    expect(
      matchIntegrationTools(candidates, { toolName: 'issues' }).tools,
    ).toEqual([candidates[2]]);
  });

  it('bounds results and reports truncation', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      integrationId: 'github',
      name: `tool_${index}`,
    }));
    const result = matchIntegrationTools(many, {});
    expect(result.tools).toHaveLength(INTEGRATION_TOOL_LOOKUP_DEFAULT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(matchIntegrationTools(many, { limit: 12 }).truncated).toBe(false);
  });

  it('prioritizes exact names over keywords without relaxing integration scope', () => {
    const tools = [
      { integrationId: 'betterstack', name: 'sources' },
      { integrationId: 'betterstack', name: 'source' },
      { integrationId: 'betterstack', name: 'query' },
      { integrationId: 'other', name: 'sources' },
    ];
    for (const tool of tools.slice(0, 3)) {
      expect(
        matchIntegrationTools(tools, {
          integrationId: 'betterstack',
          toolName: tool.name,
          query: 'source table metadata',
        }).tools,
      ).toEqual([tool]);
    }
    expect(
      matchIntegrationTools(tools, {
        integrationId: 'unattached',
        toolName: 'sources',
      }).tools,
    ).toEqual([]);
    expect(
      matchIntegrationTools(tools, {
        integrationId: 'betterstack',
        toolName: 'missing',
        query: 'sources',
      }).tools,
    ).toEqual([]);
  });
});
