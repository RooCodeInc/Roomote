import {
  getRouterMcpUpstreamConstraints,
  type RouterMcpServerId,
} from '@roomote/cloud-agents/router-mcp-policy';
import { createGitHubToken } from '@roomote/auth';
import { Env } from '@roomote/env';

import { createMcpProxy, McpProxyError } from './proxy-utils';

const DEFAULT_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const ROUTER_GITHUB_SERVER_ID: RouterMcpServerId = 'github';

function isMissingGitHubInstallationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('installation not found');
}

function buildRouterGitHubHeaders(): Record<string, string> {
  const constraints = getRouterMcpUpstreamConstraints(ROUTER_GITHUB_SERVER_ID);
  const headers: Record<string, string> = {};

  if (constraints?.readonly) {
    headers['X-MCP-Readonly'] = 'true';
  }

  if (constraints?.toolsets?.length) {
    headers['X-MCP-Toolsets'] = constraints.toolsets.join(',');
  }

  return headers;
}

export function createGithubMcp(options?: {
  allowAuthTokens?: boolean;
  allowAutomationTokens?: boolean;
  allowedToolNames?: readonly string[];
}) {
  return createMcpProxy({
    name: 'GitHub',
    upstream: Env.GITHUB_MCP_SERVER_URL ?? DEFAULT_GITHUB_MCP_URL,
    allowAuthTokens: options?.allowAuthTokens,
    allowAutomationTokens: options?.allowAutomationTokens,
    allowedToolNames: options?.allowedToolNames,
    resolveCredentials: async () => {
      let githubToken: string;
      try {
        githubToken = await createGitHubToken({ type: 'activeInstallation' });
      } catch (error) {
        if (isMissingGitHubInstallationError(error)) {
          throw new McpProxyError(
            404,
            'No active GitHub installation found for this deployment',
          );
        }
        throw error;
      }

      return {
        authHeader: githubToken,
        extraHeaders: buildRouterGitHubHeaders(),
      };
    },
  });
}
