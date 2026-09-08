import {
  getAllowedRouterMcpToolNames,
  getRouterMcpUpstreamConstraints,
  type RouterMcpServerId,
} from '@roomote/cloud-agents/router-mcp-policy';
import {
  createGitHubToken,
  resolveRuntimeGitHubAppCredentials,
} from '@roomote/auth';
import { and, db, eq, isNull, repositories, users } from '@roomote/db/server';
import { Env } from '@roomote/env';
import { z } from 'zod';

import {
  createMcpProxy,
  McpProxyError,
  resolveActingUserId,
} from './proxy-utils';

const DEFAULT_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const ROUTER_GITHUB_SERVER_ID: RouterMcpServerId = 'github';

const repositoryArgs = z.object({
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .refine((value) => value !== '.' && value !== '..'),
});
const writeToolNames = [
  'update_pull_request',
  'add_issue_comment',
  'add_reply_to_pull_request_comment',
];

function isMissingGitHubInstallationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('installation not found');
}

function buildRouterGitHubHeaders(readonly: boolean): Record<string, string> {
  const constraints = getRouterMcpUpstreamConstraints(ROUTER_GITHUB_SERVER_ID);
  const headers: Record<string, string> = {};

  headers['X-MCP-Readonly'] = String(
    readonly || constraints?.readonly === true,
  );

  if (constraints?.toolsets?.length) {
    headers['X-MCP-Toolsets'] = constraints.toolsets.join(',');
  }

  return headers;
}

export function createGithubMcp(options?: {
  allowAuthTokens?: boolean;
  allowedToolNames?: readonly string[];
}) {
  const allowedToolNames = getAllowedRouterMcpToolNames('github').filter(
    (name) =>
      !options?.allowedToolNames || options.allowedToolNames.includes(name),
  );
  return createMcpProxy({
    name: 'GitHub',
    upstream: Env.GITHUB_MCP_SERVER_URL ?? DEFAULT_GITHUB_MCP_URL,
    allowAuthTokens: options?.allowAuthTokens,
    allowedToolNames,
    resolveCredentials: async (auth, _params, request) => {
      if (Array.isArray(request))
        throw new McpProxyError(
          400,
          'GitHub MCP batch requests are not allowed',
        );
      const rpc = request as
        | { method?: string; params?: { name?: string; arguments?: unknown } }
        | undefined;
      const name = rpc?.method === 'tools/call' ? rpc.params?.name : undefined;
      if (
        rpc?.method === 'tools/call' &&
        (typeof name !== 'string' || !allowedToolNames.includes(name))
      ) {
        throw new McpProxyError(
          403,
          'GitHub MCP tool is not allowed on this endpoint',
        );
      }
      if (name && writeToolNames.includes(name)) {
        // Fast uses user tokens. Keep run tokens read-only here rather than
        // creating a second write path around coding-task repository scope.
        if (auth.tokenType !== 'auth') {
          throw new McpProxyError(
            403,
            'GitHub MCP writes require a user-scoped auth token',
          );
        }
        const parsed = repositoryArgs.safeParse(rpc?.params?.arguments);
        if (!parsed.success)
          throw new McpProxyError(
            400,
            'Invalid GitHub write repository arguments',
          );
        const args = parsed.data;
        const userId = await resolveActingUserId(auth);
        const actor = await db.query.users.findFirst({
          where: and(eq(users.id, userId), isNull(users.deletedAt)),
          columns: { id: true },
        });
        if (!actor)
          throw new McpProxyError(
            403,
            'GitHub writes require an active Roomote member',
          );
        // Repository access is deployment-scoped, matching the existing repository
        // helpers. Do not mistake a stored installation owner for a per-user ACL.
        const repository = await db.query.repositories.findFirst({
          where: and(
            eq(repositories.sourceControlProvider, 'github'),
            eq(repositories.fullName, `${args.owner}/${args.repo}`),
            eq(repositories.isActive, true),
          ),
          with: { githubInstallation: true },
        });
        const installation = repository?.githubInstallation;
        if (
          !repository ||
          !installation ||
          installation.suspendedAt ||
          repository.installationId !== installation.id ||
          !repository.githubRepoId ||
          !Number.isSafeInteger(repository.githubRepoId) ||
          repository.githubRepoId < 1 ||
          (repository.host && repository.host !== 'github.com')
        ) {
          throw new McpProxyError(
            403,
            'GitHub write target must be an active connected repository',
          );
        }
        const permissions = installation.permissions as Record<
          string,
          unknown
        > | null;
        const requiredPermissions =
          name === 'add_issue_comment'
            ? ['issues', 'pull_requests']
            : ['pull_requests'];
        if (
          !requiredPermissions.some(
            (permission) => permissions?.[permission] === 'write',
          )
        ) {
          throw new McpProxyError(
            403,
            'GitHub installation lacks the required issue or pull request write permission',
          );
        }
        const appCredentials = await resolveRuntimeGitHubAppCredentials();
        if (String(installation.appId) !== appCredentials.appId)
          throw new McpProxyError(
            403,
            'GitHub repository installation does not belong to the configured app',
          );
        const token = await createGitHubToken(
          {
            type: 'installationId',
            installationId: installation.id,
            repositoryIds: [repository.githubRepoId],
          },
          appCredentials,
        );
        const originalArgs = rpc?.params?.arguments as Record<string, unknown>;
        const targetNumber =
          originalArgs.pullNumber ?? originalArgs.issue_number;
        console.info(
          JSON.stringify({
            event: 'github_mcp_write_authorized',
            userId,
            runId: auth.runId,
            tool: name,
            repositoryId: repository.id,
            repositoryFullName: repository.fullName,
            installationId: installation.installationId,
            targetNumber:
              typeof targetNumber === 'number' ? targetNumber : undefined,
            commentId:
              typeof originalArgs.commentId === 'number'
                ? originalArgs.commentId
                : undefined,
          }),
        );
        return {
          authHeader: token,
          extraHeaders: buildRouterGitHubHeaders(false),
        };
      }
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
        disabledToolNames:
          auth.tokenType === 'run' ? writeToolNames : undefined,
        extraHeaders: buildRouterGitHubHeaders(
          auth.tokenType === 'run' || rpc?.method !== 'tools/list',
        ),
      };
    },
  });
}
