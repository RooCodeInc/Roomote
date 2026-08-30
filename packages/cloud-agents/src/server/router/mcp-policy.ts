import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  parseDiscordMessagePermalink,
  parseSlackChannelPermalink,
  parseSlackMessagePermalink,
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

const ROUTER_MCP_TOOL_GROUPS: Record<RouterMcpToolGroup, readonly string[]> = {
  'roomote-platform-context': ['get_about_me'],
  'roomote-chat-context': [
    CHAT_MESSAGE_CONTEXT_TOOL.name,
    CHAT_CHANNEL_MESSAGES_TOOL.name,
  ],
  'linear-issue-context': ['get_issue', 'list_issues'],
  'linear-comment-context': ['list_comments'],
  'github-pr-context': [
    'get_pull_request',
    'pull_request_read',
    'list_pull_requests',
    'search_pull_requests',
  ],
  'github-issue-context': ['issue_read', 'get_issue'],
  'github-repo-context': [
    'get_file_contents',
    'search_code',
    'get_commit',
    'list_commits',
  ],
};

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

export function isRouterMcpToolAllowed(
  serverId: RouterMcpServerId,
  toolName: string,
): boolean {
  return getAllowedRouterMcpToolNames(serverId).includes(toolName);
}

export function getRouterMcpToolGroupToolNames(
  group: RouterMcpToolGroup,
): readonly string[] {
  return ROUTER_MCP_TOOL_GROUPS[group];
}

export function getRequiredRouterMcpToolGroups(
  serverId: RouterMcpServerId,
): readonly RouterMcpToolGroup[] {
  return getRouterMcpServerPolicy(serverId).requiredToolGroups ?? [];
}

export function getRouterMcpUpstreamConstraints(
  serverId: RouterMcpServerId,
): RouterMcpUpstreamConstraints | undefined {
  return getRouterMcpServerPolicy(serverId).upstreamConstraints;
}

export function getMissingRequiredRouterMcpToolGroups(
  serverId: RouterMcpServerId,
  availableToolNames: readonly string[],
): RouterMcpToolGroup[] {
  const availableToolSet = new Set(availableToolNames);

  return getRequiredRouterMcpToolGroups(serverId).filter(
    (group) =>
      !getRouterMcpToolGroupToolNames(group).some((toolName) =>
        availableToolSet.has(toolName),
      ),
  );
}

export function shouldIncludeRoomoteRouterLookup(
  externalReference: string | null,
): boolean {
  if (!externalReference) {
    return false;
  }

  const candidates = [
    externalReference,
    ...(externalReference.match(/https?:\/\/[^\s<>'"\])}]+/gi) ?? []),
  ];

  return candidates.some((candidate) => {
    const normalized = candidate.replace(/[.,;:!?]+$/, '');
    return (
      parseSlackMessagePermalink(normalized) !== null ||
      parseSlackChannelPermalink(normalized) !== null ||
      parseDiscordMessagePermalink(normalized) !== null
    );
  });
}
