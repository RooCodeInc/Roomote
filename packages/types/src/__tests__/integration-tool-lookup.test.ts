import {
  FIND_INTEGRATION_TOOLS_ARG_DESCRIPTIONS,
  INTEGRATION_TOOL_LOOKUP_DEFAULT_LIMIT,
  matchIntegrationTools,
} from '../integration-tool-lookup';

const candidates = [
  { integrationId: 'github', name: 'search_code', description: 'Search code' },
  { integrationId: 'github', name: 'list_issues', description: 'List issues' },
  { integrationId: 'linear', name: 'issues', description: 'Search issues' },
];

describe('matchIntegrationTools', () => {
  it('describes keyword lookup as conjunctive', () => {
    expect(FIND_INTEGRATION_TOOLS_ARG_DESCRIPTIONS.query).toContain(
      'every whitespace-separated keyword must match one tool',
    );
  });

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
    expect(
      matchIntegrationTools(candidates, {
        integrationId: 'github',
        query: 'database',
      }),
    ).toMatchObject({ tools: [], availableToolCount: 2 });
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

  it('classifies a broad conjunctive Sentry query as a filter miss, not an empty catalog', () => {
    const sentryTools = [
      ['find_organizations', 'Find organizations'],
      ['find_projects', 'Find projects'],
      ['update_issue', 'Update issue status or assignment'],
      ['search_events', 'Search events and replays'],
      ['analyze_issue_with_seer', 'Analyze a production issue'],
      ['search_issues', 'Search grouped issues'],
      ['get_sentry_resource', 'Fetch issue event trace or replay details'],
      ['search_sentry_tools', 'Search tool catalog by name and description'],
      ['execute_sentry_tool', 'Execute an available Sentry tool'],
    ].map(([name, description]) => ({
      integrationId: 'sentry',
      name: name!,
      description,
    }));

    expect(
      matchIntegrationTools(sentryTools, {
        integrationId: 'sentry',
        query:
          'search issues events event details breadcrumbs issue events tags releases',
        limit: 20,
      }),
    ).toMatchObject({
      tools: [],
      availableToolCount: 9,
      truncated: false,
    });
  });
});
