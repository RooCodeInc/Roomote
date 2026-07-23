import type { RouterMcpServerId } from './mcp-policy';

/**
 * One MCP call the router may make to fetch a matched issue. Attempts run in
 * order until one returns a result, so older tool names can trail newer ones
 * as fallbacks.
 */
export interface ExternalIssueFetchAttempt {
  serverId: RouterMcpServerId;
  toolName: string;
  args: Record<string, unknown>;
}

interface ExternalIssueUrlMatch {
  fetchAttempts: readonly ExternalIssueFetchAttempt[];
}

/**
 * Declarative issue-link provider: which hostnames it owns, the pathname
 * shape that identifies one of its issues, and how a match turns into MCP
 * fetch attempts. Adding SCM support is one new entry here (plus the MCP
 * server itself and its mcp-policy allowlist) — parsing and fetching stay in
 * deterministic code, never the model.
 */
export interface ExternalIssueProvider {
  id: string;
  hostnames: readonly string[];
  pathPattern: RegExp;
  buildFetchAttempts(
    groups: Record<string, string>,
  ): readonly ExternalIssueFetchAttempt[];
}

const EXTERNAL_ISSUE_PROVIDERS: readonly ExternalIssueProvider[] = [
  {
    id: 'github',
    hostnames: ['github.com'],
    pathPattern:
      /^\/(?<owner>[^/]+)\/(?<repository>[^/]+)\/issues\/(?<issueNumber>\d+)(?:\/.*)?$/,
    buildFetchAttempts: (groups) => [
      {
        serverId: 'github',
        toolName: 'issue_read',
        args: {
          method: 'get',
          owner: groups.owner,
          repo: groups.repository,
          issue_number: Number(groups.issueNumber),
        },
      },
      {
        serverId: 'github',
        toolName: 'get_issue',
        args: {
          owner: groups.owner,
          repo: groups.repository,
          issue_number: Number(groups.issueNumber),
        },
      },
    ],
  },
  {
    id: 'linear',
    hostnames: ['linear.app'],
    pathPattern: /^\/[^/]+\/issue\/(?<identifier>[A-Za-z]+-\d+)(?:\/.*)?$/,
    buildFetchAttempts: (groups) => [
      {
        serverId: 'linear',
        toolName: 'get_issue',
        args: { id: groups.identifier },
      },
    ],
  },
];

export function matchExternalIssueUrl(
  url: URL,
  providers: readonly ExternalIssueProvider[] = EXTERNAL_ISSUE_PROVIDERS,
): ExternalIssueUrlMatch | null {
  for (const provider of providers) {
    if (!provider.hostnames.includes(url.hostname)) {
      continue;
    }

    const groups = url.pathname.match(provider.pathPattern)?.groups;

    if (!groups || Object.values(groups).some((value) => value == null)) {
      continue;
    }

    return { fetchAttempts: provider.buildFetchAttempts(groups) };
  }

  return null;
}
