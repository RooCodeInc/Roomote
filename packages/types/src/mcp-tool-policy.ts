import type { McpIntegration } from './mcp-oauth';

const BETTER_STACK_READ_ONLY_UPTIME_TOOL_NAMES = [
  'uptime_get_escalation_policy_tool',
  'uptime_get_heartbeat_availability_tool',
  'uptime_get_heartbeat_tool',
  'uptime_get_incident_comments_tool',
  'uptime_get_incident_escalation_options_tool',
  'uptime_get_incident_timeline_tool',
  'uptime_get_incident_tool',
  'uptime_get_monitor_availability_tool',
  'uptime_get_monitor_response_times_tool',
  'uptime_get_monitor_tool',
  'uptime_get_on_call_event_tool',
  'uptime_get_on_call_rotation_tool',
  'uptime_get_on_call_tool',
  'uptime_get_severity_tool',
  'uptime_get_status_page_report_update_tool',
  'uptime_get_status_page_resources_tool',
  'uptime_get_status_page_tool',
  'uptime_list_escalation_policies_tool',
  'uptime_list_heartbeats_tool',
  'uptime_list_incidents_tool',
  'uptime_list_monitors_tool',
  'uptime_list_on_call_events_tool',
  'uptime_list_on_calls_tool',
  'uptime_list_severities_tool',
  'uptime_list_status_page_report_updates_tool',
  'uptime_list_status_page_reports_tool',
  'uptime_list_status_pages_tool',
] as const;

const BETTER_STACK_READ_ONLY_TELEMETRY_TOOL_NAMES = [
  'better_stack_search_documentation_tool',
  'telemetry_build_explore_query_tool',
  'telemetry_build_metric_query_tool',
  'telemetry_chart',
  'telemetry_export_dashboard_tool',
  'telemetry_get_application_details_tool',
  'telemetry_get_chart_alert_details_tool',
  'telemetry_get_chart_alert_instructions_tool',
  'telemetry_get_chart_building_instructions_tool',
  'telemetry_get_chart_details_tool',
  'telemetry_get_dashboard_details_tool',
  'telemetry_get_error_details_tool',
  'telemetry_get_errors_query_instructions_tool',
  'telemetry_get_metric_details_tool',
  'telemetry_get_metric_query_instructions_tool',
  'telemetry_get_metrics_and_cardinality_tool',
  'telemetry_get_query_instructions_tool',
  'telemetry_get_replays_query_instructions_tool',
  'telemetry_get_source_details_tool',
  'telemetry_get_source_fields_tool',
  'telemetry_list_applications_tool',
  'telemetry_list_chart_alerts_tool',
  'telemetry_list_clusters_tool',
  'telemetry_list_dashboard_templates_tool',
  'telemetry_list_dashboards_tool',
  'telemetry_list_data_regions_tool',
  'telemetry_list_releases_tool',
  'telemetry_list_sources_tool',
  'telemetry_list_teams_tool',
  'telemetry_query',
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
