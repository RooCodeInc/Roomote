import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
} from '@roomote/types';

export const ROUTER_MCP_ENABLED_SERVER_IDS = [
  'roomote',
  'linear',
  'github',
] as const;

export type RouterMcpServerId = (typeof ROUTER_MCP_ENABLED_SERVER_IDS)[number];

type RouterMcpPolicyPurpose =
  | 'roomote-platform-context'
  | 'linear-issue-context'
  | 'github-pr-context';

type RouterMcpToolGroup =
  | 'roomote-platform-context'
  | 'roomote-chat-context'
  | 'linear-issue-context'
  | 'linear-comment-context'
  | 'github-pr-context'
  | 'github-issue-context'
  | 'github-repo-context';

interface RouterMcpUpstreamConstraints {
  readonly?: boolean;
  toolsets?: readonly string[];
}

interface RouterMcpServerPolicy {
  enabled: boolean;
  purpose: RouterMcpPolicyPurpose;
  exposureMode: 'allowlist';
  allowedTools: readonly string[];
  requiredToolGroups?: readonly RouterMcpToolGroup[];
  upstreamConstraints?: RouterMcpUpstreamConstraints;
}

const ROUTER_ROOMOTE_ALLOWED_TOOLS = [
  'get_about_me',
  CHAT_CHANNEL_MESSAGES_TOOL.name,
  CHAT_MESSAGE_CONTEXT_TOOL.name,
] as const;

const ROUTER_LINEAR_ALLOWED_TOOLS = [
  'get_issue',
  'list_issues',
  'list_comments',
  'get_document',
  'list_documents',
  'extract_images',
  'list_projects',
  'get_project',
  'list_milestones',
  'get_milestone',
  'list_cycles',
  'list_teams',
  'get_team',
  'list_users',
  'get_user',
] as const;

const ROUTER_GITHUB_ALLOWED_TOOLS = [
  'actions_get',
  'actions_list',
  'get_job_logs',
  'get_pull_request',
  'pull_request_read',
  'list_pull_requests',
  'search_pull_requests',
  'issue_read',
  'get_issue',
  'get_file_contents',
  'search_code',
  'get_commit',
  'list_commits',
  'search_repositories',
  'list_branches',
] as const;

const ROUTER_MCP_SERVER_POLICIES: Record<
  RouterMcpServerId,
  RouterMcpServerPolicy
> = {
  roomote: {
    enabled: true,
    purpose: 'roomote-platform-context',
    exposureMode: 'allowlist',
    allowedTools: ROUTER_ROOMOTE_ALLOWED_TOOLS,
    requiredToolGroups: ['roomote-platform-context', 'roomote-chat-context'],
  },
  linear: {
    enabled: true,
    purpose: 'linear-issue-context',
    exposureMode: 'allowlist',
    allowedTools: ROUTER_LINEAR_ALLOWED_TOOLS,
    requiredToolGroups: ['linear-issue-context'],
  },
  github: {
    enabled: true,
    purpose: 'github-pr-context',
    exposureMode: 'allowlist',
    allowedTools: ROUTER_GITHUB_ALLOWED_TOOLS,
    requiredToolGroups: ['github-pr-context', 'github-issue-context'],
    upstreamConstraints: {
      readonly: true,
      toolsets: ['repos', 'pull_requests', 'issues', 'actions'],
    },
  },
};

export function getRouterMcpServerPolicy(
  serverId: RouterMcpServerId,
): RouterMcpServerPolicy {
  return ROUTER_MCP_SERVER_POLICIES[serverId];
}

export function isRouterMcpServerEnabled(
  serverId: string,
): serverId is RouterMcpServerId {
  return (
    ROUTER_MCP_ENABLED_SERVER_IDS.includes(serverId as RouterMcpServerId) &&
    ROUTER_MCP_SERVER_POLICIES[serverId as RouterMcpServerId].enabled
  );
}

export function getAllowedRouterMcpToolNames(
  serverId: RouterMcpServerId,
): readonly string[] {
  return getRouterMcpServerPolicy(serverId).allowedTools;
}

export function getRouterMcpUpstreamConstraints(
  serverId: RouterMcpServerId,
): RouterMcpUpstreamConstraints | undefined {
  return getRouterMcpServerPolicy(serverId).upstreamConstraints;
}
