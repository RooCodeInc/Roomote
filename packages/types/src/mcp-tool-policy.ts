import type { McpIntegration } from './mcp-oauth';

export const MCP_TOOL_ACCESS_MODES = ['read_only', 'read_write'] as const;

export type McpToolAccessMode = (typeof MCP_TOOL_ACCESS_MODES)[number];

export type McpToolAccessModeConfig = {
  readonly defaultMode: McpToolAccessMode;
  readonly supportedModes: readonly McpToolAccessMode[];
  readonly readOnlyToolNames: readonly string[];
};

/** Roomote's native Notion tools that do not mutate content. */
export const NOTION_READ_ONLY_TOOL_NAMES = [
  'notion-search',
  'notion-fetch',
  'notion-query-data-sources',
  'notion-get-comments',
] as const;

export const NOTION_MCP_TOOL_DEFINITIONS = [
  {
    name: 'notion-search',
    description: 'Search explicitly shared Notion pages and data sources.',
  },
  {
    name: 'notion-fetch',
    description:
      'Fetch an explicitly shared Notion page, data source, or block.',
  },
  {
    name: 'notion-query-data-sources',
    description: 'Query rows from an explicitly shared Notion data source.',
  },
  {
    name: 'notion-get-comments',
    description: 'List comments on an explicitly shared Notion page or block.',
  },
  {
    name: 'notion-create-pages',
    description: 'Create a page beneath an available Notion parent.',
  },
  {
    name: 'notion-update-page',
    description: 'Update an available Notion page.',
  },
  {
    name: 'notion-append-blocks',
    description: 'Append content blocks to an available Notion page or block.',
  },
  {
    name: 'notion-create-comment',
    description: 'Create a comment on an available Notion page.',
  },
] as const;

const INTEGRATION_MCP_TOOL_ACCESS_MODE_CONFIGS: Readonly<
  Partial<Record<string, McpToolAccessModeConfig>>
> = {
  notion: {
    defaultMode: 'read_only',
    supportedModes: MCP_TOOL_ACCESS_MODES,
    readOnlyToolNames: NOTION_READ_ONLY_TOOL_NAMES,
  },
};

const BETTER_STACK_READ_ONLY_UPTIME_TOOL_NAMES = [
  'escalation_policy',
  'heartbeat_availability',
  'heartbeat',
  'incident_comments',
  'incident_escalation_options',
  'incident_timeline',
  'incident',
  'monitor_availability',
  'monitor_response_times',
  'monitor',
  'on_call_event',
  'on_call_rotation',
  'on_call',
  'severity',
  'status_page_report_update',
  'status_page_resources',
  'status_page',
  'escalation_policies',
  'heartbeats',
  'incidents',
  'monitors',
  'on_call_events',
  'on_calls',
  'severities',
  'status_page_report_updates',
  'status_page_reports',
  'status_pages',
] as const;

const BETTER_STACK_READ_ONLY_TELEMETRY_TOOL_NAMES = [
  'search_documentation',
  'explore_query_instructions',
  'render_chart',
  'export_dashboard',
  'application',
  'chart_alert',
  'chart_alert_instructions',
  'chart_building_instructions',
  'chart',
  'dashboard',
  'error',
  'errors_query_instructions',
  'metric',
  'metric_query_instructions',
  'metrics',
  'query_instructions',
  'replays_query_instructions',
  'source',
  'source_fields',
  'applications',
  'chart_alerts',
  'clusters',
  'dashboard_templates',
  'dashboards',
  'data_regions',
  'releases',
  'sources',
  'teams',
  'query',
] as const;

const BETTER_STACK_READ_ONLY_TOOL_NAMES = [
  ...BETTER_STACK_READ_ONLY_UPTIME_TOOL_NAMES,
  ...BETTER_STACK_READ_ONLY_TELEMETRY_TOOL_NAMES,
] as const;

export const GRAFANA_READ_ONLY_TOOL_NAMES = [
  'list_dashboards',
  'search_dashboards',
  'get_dashboard',
  'list_alert_rules',
  'get_alert_rule',
  'list_alert_instances',
  'list_data_sources',
  'list_annotations',
] as const;

const RAILWAY_READ_ONLY_TOOL_NAMES = [
  'whoami',
  'list-projects',
  'list-services',
] as const;

const PYLON_READ_ONLY_TOOL_NAMES = [
  'search_issues',
  'get_issue',
  'get_issue_messages',
  'search_accounts',
  'get_account',
] as const;

const SENTRY_READ_ONLY_TOOL_NAMES = [
  'whoami',
  'find_organizations',
  'find_teams',
  'find_projects',
  'find_releases',
  'get_issue_details',
  'get_issue_tag_values',
  'get_trace_details',
  'get_replay_details',
  'get_event_attachment',
  'search_events',
  'find_dsns',
  'search_docs',
  'get_doc',
  'search_issues',
  'search_issue_events',
  'get_profile_details',
  'get_sentry_resource',
] as const;

const JIRA_SHARED_TOOL_NAMES = [
  'atlassianUserInfo',
  'getAccessibleAtlassianResources',
] as const;

const JIRA_READ_ONLY_TOOL_NAMES = [
  ...JIRA_SHARED_TOOL_NAMES,
  'getJiraIssue',
  'getJiraIssueRemoteIssueLinks',
  'getJiraIssueTypeMetaWithFields',
  'getJiraProjectIssueTypesMetadata',
  'getIssueLinkTypes',
  'getTransitionsForJiraIssue',
  'getVisibleJiraProjects',
  'lookupJiraAccountId',
  'searchJiraIssuesUsingJql',
] as const;

const MONDAY_READ_ONLY_TOOL_NAMES = [
  'get_board_info',
  'get_board_items_page',
  'get_board_activity',
  'board_insights',
  'get_column_type_info',
  'list_workspaces',
  'workspace_info',
  'read_docs',
  'all_widgets_schema',
  'get_form',
  'get_user_context',
  'list_users_and_teams',
  'get_updates',
  'search',
  'get_assets',
  'list_automations',
  'plan_workflow',
  'agent_catalog',
  'get_notetaker_meetings',
  'get_monday_dev_sprints_boards',
  'get_sprints_metadata',
  'get_sprint_summary',
  'get_graphql_schema',
  'get_type_details',
] as const;

/**
 * X's hosted MCP server exposes a curated subset of X API v2 operations, one
 * tool per operation, named in snake_case (e.g. `search_posts_all`, not the
 * camelCase `searchPostsAll` operationId). This allowlist keeps the read-only,
 * public-data subset that works with an app-only bearer token; mutating
 * operations and user-context surfaces (posting, bookmarks, DMs, mentions,
 * timelines) are excluded. The exact set the server advertises varies with the
 * connected X API plan, so this lists every read-only public-data tool we
 * expect across plans; names the server does not advertise simply never match.
 */
const X_READ_ONLY_TOOL_NAMES = [
  'search_posts_recent',
  'search_posts_all',
  'get_posts_counts_recent',
  'get_posts_counts_all',
  'get_posts_by_id',
  'get_posts_by_ids',
  'get_posts_quoted_posts',
  'get_posts_reposted_by',
  'get_posts_reposts',
  'get_posts_liking_users',
  'get_users_by_id',
  'get_users_by_ids',
  'get_users_by_username',
  'get_users_by_usernames',
  'search_users',
  'get_users_posts',
  'get_users_followers',
  'get_users_following',
  'get_users_liked_posts',
  'get_users_owned_lists',
  'get_trends_by_woeid',
  'get_news',
  'search_news',
  'get_lists_by_id',
  'get_lists_posts',
  'get_lists_members',
  'get_lists_followers',
  'get_spaces_by_id',
  'get_spaces_by_ids',
  'get_spaces_posts',
  'search_spaces',
  'get_communities_by_id',
  'search_communities',
  'get_usage',
] as const;

const INTEGRATION_MCP_ALLOWED_TOOL_NAMES: Readonly<
  Partial<Record<string, readonly string[]>>
> = {
  betterstack: BETTER_STACK_READ_ONLY_TOOL_NAMES,
  grafana: GRAFANA_READ_ONLY_TOOL_NAMES,
  jira: JIRA_READ_ONLY_TOOL_NAMES,
  monday: MONDAY_READ_ONLY_TOOL_NAMES,
  pylon: PYLON_READ_ONLY_TOOL_NAMES,
  railway: RAILWAY_READ_ONLY_TOOL_NAMES,
  sentry: SENTRY_READ_ONLY_TOOL_NAMES,
  x: X_READ_ONLY_TOOL_NAMES,
};

export type McpToolPolicy = {
  allowedToolNames?: readonly string[];
  disabledToolNames?: readonly string[] | null;
};

export function getAllowedIntegrationMcpToolNames(
  integrationOrId: McpIntegration | string,
  toolAccessMode?: string | null,
): readonly string[] | undefined {
  const integrationId =
    typeof integrationOrId === 'string' ? integrationOrId : integrationOrId.id;

  const accessModeConfig =
    INTEGRATION_MCP_TOOL_ACCESS_MODE_CONFIGS[integrationId];
  if (accessModeConfig) {
    return resolveMcpIntegrationToolAccessMode(
      integrationId,
      toolAccessMode,
    ) === 'read_write'
      ? undefined
      : accessModeConfig.readOnlyToolNames;
  }

  return INTEGRATION_MCP_ALLOWED_TOOL_NAMES[integrationId];
}

export function getMcpIntegrationToolAccessModeConfig(
  integrationOrId: McpIntegration | string,
): McpToolAccessModeConfig | undefined {
  const integrationId =
    typeof integrationOrId === 'string' ? integrationOrId : integrationOrId.id;

  return INTEGRATION_MCP_TOOL_ACCESS_MODE_CONFIGS[integrationId];
}

export function resolveMcpIntegrationToolAccessMode(
  integrationOrId: McpIntegration | string,
  storedMode?: string | null,
): McpToolAccessMode | undefined {
  const config = getMcpIntegrationToolAccessModeConfig(integrationOrId);
  if (!config) {
    return undefined;
  }

  return config.supportedModes.includes(storedMode as McpToolAccessMode)
    ? (storedMode as McpToolAccessMode)
    : config.defaultMode;
}

export function isMcpToolAllowed(
  toolName: string,
  policy: McpToolPolicy,
): boolean {
  if (policy.allowedToolNames && !policy.allowedToolNames.includes(toolName)) {
    return false;
  }

  return !(policy.disabledToolNames ?? []).includes(toolName);
}

export function filterMcpToolDefinitions<T extends { name: string }>(
  tools: readonly T[],
  policy: McpToolPolicy,
): T[] {
  return tools.filter((tool) => isMcpToolAllowed(tool.name, policy));
}

export function getEffectiveAllowedMcpToolNames(
  policy: McpToolPolicy,
): string[] | undefined {
  if (!policy.allowedToolNames) {
    return undefined;
  }

  return filterMcpToolDefinitions(
    policy.allowedToolNames.map((name) => ({ name })),
    policy,
  ).map((tool) => tool.name);
}
