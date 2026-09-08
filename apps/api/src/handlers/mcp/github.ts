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

const repositoryArgs = {
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .refine((value) => value !== '.' && value !== '..'),
};
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Keep upstream names, but expose and accept only these bounded operations.
const writeTools = {
  update_pull_request: {
    description:
      'Update only the title, body, or open/closed state of an existing GitHub pull request in an active connected repository. Supply at least one change. Does not merge or change branches, reviewers, or draft status.',
    schema: z
      .object({
        ...repositoryArgs,
        pullNumber: positiveId,
        title: z.string().min(1).max(256).optional(),
        body: z.string().max(65536).optional(),
        state: z.enum(['open', 'closed']).optional(),
      })
      .strict(),
  },
  add_issue_comment: {
    description:
      'Add a top-level comment to a GitHub issue or pull request in an active connected repository. For a pull request, pass its number as issue_number. Does not edit or delete comments or add reactions.',
    schema: z
      .object({
        ...repositoryArgs,
        issue_number: positiveId,
        body: z.string().min(1).max(65536),
      })
      .strict(),
  },
  add_reply_to_pull_request_comment: {
    description:
      'Reply to an existing GitHub pull request review comment in an active connected repository. Use the numeric commentId, not a GraphQL thread ID. Does not add reactions or submit a review.',
    schema: z
      .object({
        ...repositoryArgs,
        pullNumber: positiveId,
        commentId: positiveId,
        body: z.string().min(1).max(65536),
      })
      .strict(),
  },
};

function getWriteTool(name: string) {
  return Object.hasOwn(writeTools, name)
    ? writeTools[name as keyof typeof writeTools]
    : undefined;
}

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
    transformToolDefinition: (tool) => {
      const writeTool = getWriteTool(tool.name);
      if (!writeTool) return tool;
      const upstreamSchema = tool.inputSchema as
        | { properties?: Record<string, unknown> }
        | undefined;
      const fields = Object.entries(writeTool.schema.shape);
      if (fields.some(([name]) => !upstreamSchema?.properties?.[name])) {
        throw new Error(
          'GitHub upstream write schema is missing a bounded field',
        );
      }
      return {
        ...tool,
        description: writeTool.description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            fields.map(([name]) => [
              name,
              upstreamSchema?.properties?.[name] ?? {},
            ]),
          ),
          required: fields
            .filter(([, schema]) => !schema.isOptional())
            .map(([name]) => name),
          additionalProperties: false,
        },
      };
    },
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
      const writeTool = name ? getWriteTool(name) : undefined;
      if (writeTool) {
        // Fast uses user tokens. Keep run tokens read-only here rather than
        // creating a second write path around coding-task repository scope.
        if (auth.tokenType !== 'auth') {
          throw new McpProxyError(
            403,
            'GitHub MCP writes require a user-scoped auth token',
          );
        }
        const parsed = writeTool.schema.safeParse(rpc?.params?.arguments);
        if (!parsed.success)
          throw new McpProxyError(
            400,
            'Invalid bounded GitHub write arguments',
          );
        const args = parsed.data;
        if (
          name === 'update_pull_request' &&
          !['title', 'body', 'state'].some((field) =>
            Object.hasOwn(args, field),
          )
        ) {
          throw new McpProxyError(
            400,
            'Provide a pull request title, body, or state change',
          );
        }
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
              'pullNumber' in args ? args.pullNumber : args.issue_number,
            commentId: 'commentId' in args ? args.commentId : undefined,
            fields: Object.keys(args).filter(
              (field) => !['owner', 'repo'].includes(field),
            ),
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
          auth.tokenType === 'run' ? Object.keys(writeTools) : undefined,
        extraHeaders: buildRouterGitHubHeaders(
          auth.tokenType === 'run' || rpc?.method !== 'tools/list',
        ),
      };
    },
  });
}
