import type { McpIntegration } from './mcp-oauth';

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
};

export type McpToolPolicy = {
  allowedToolNames?: readonly string[];
  disabledToolNames?: readonly string[] | null;
};

export function getAllowedIntegrationMcpToolNames(
  integrationOrId: McpIntegration | string,
): readonly string[] | undefined {
  const integrationId =
    typeof integrationOrId === 'string' ? integrationOrId : integrationOrId.id;

  return INTEGRATION_MCP_ALLOWED_TOOL_NAMES[integrationId];
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
