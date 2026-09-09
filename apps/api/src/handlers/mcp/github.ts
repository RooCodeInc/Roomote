import {
  getAllowedRouterMcpToolNames,
  getRouterMcpUpstreamConstraints,
  type RouterMcpServerId,
} from '@roomote/cloud-agents/router-mcp-policy';
import {
  createGitHubToken,
  resolveRuntimeGitHubAppCredentials,
} from '@roomote/auth';
import {
  and,
  db,
  eq,
  githubInstallations,
  gt,
  isNull,
  lte,
  or,
  repositories,
  sql,
  users,
} from '@roomote/db/server';
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

const searchScopeError =
  'Split searches by connected repository. Use one positive repo:owner/name qualifier with no boolean operators, negation, grouping, quotes, or regex. Any owner or repo argument must match the query scope.';

function getReadTarget(name: string, args: unknown) {
  if (
    ['search_code', 'search_pull_requests', 'search_repositories'].includes(
      name,
    )
  ) {
    const parsed = z
      .object({
        query: z.string().min(1),
        owner: repositoryArgs.shape.owner.optional(),
        repo: repositoryArgs.shape.repo.optional(),
      })
      .safeParse(args);
    if (!parsed.success) throw new McpProxyError(400, searchScopeError);
    const query = parsed.data.query.trim();
    let target: { owner: string; repo: string } | undefined;
    // Deliberately accept a small conjunction-only subset, not a second
    // implementation of GitHub's evolving boolean/regex search parser.
    const tokens = query.split(/\s+/);
    const scopes = tokens.filter((token) => /repo:|org:|user:/i.test(token));
    const match =
      scopes.length === 1
        ? /^repo:([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9_.-]+)$/.exec(
            scopes[0]!,
          )
        : null;
    if (
      match &&
      !/[()"'\\]/.test(query) &&
      !tokens.some(
        (token) =>
          /^(?:OR|NOT|AND)$/i.test(token) ||
          token.startsWith('-') ||
          (!token.startsWith('repo:') && token.includes('/')),
      )
    ) {
      target = { owner: match[1]!, repo: match[2]! };
    }
    if (!target || !repositoryArgs.safeParse(target).success)
      throw new McpProxyError(400, searchScopeError);
    if (
      (parsed.data.owner !== undefined &&
        parsed.data.owner.toLowerCase() !== target.owner.toLowerCase()) ||
      (parsed.data.repo !== undefined &&
        parsed.data.repo.toLowerCase() !== target.repo.toLowerCase())
    )
      throw new McpProxyError(400, searchScopeError);
    return target;
  }
  const parsed = repositoryArgs.safeParse(args);
  if (!parsed.success)
    throw new McpProxyError(
      400,
      'GitHub reads require an explicit owner and repo',
    );
  return parsed.data;
}

async function resolveRepository(fullName?: string) {
  const appCredentials = await resolveRuntimeGitHubAppCredentials();
  const matches = await db
    .select({ repository: repositories, installation: githubInstallations })
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.sourceControlProvider, 'github'),
        eq(repositories.isActive, true),
        or(isNull(repositories.host), eq(repositories.host, 'github.com')),
        gt(repositories.githubRepoId, 0),
        lte(repositories.githubRepoId, Number.MAX_SAFE_INTEGER),
        eq(githubInstallations.appId, Number(appCredentials.appId)),
        isNull(githubInstallations.suspendedAt),
        fullName
          ? sql`lower(${repositories.fullName}) = ${fullName.toLowerCase()}`
          : undefined,
      ),
    )
    .orderBy(githubInstallations.id, repositories.id)
    .limit(fullName ? 2 : 1);
  const match = matches[0];
  if (
    !match ||
    matches.length !== 1 ||
    match.repository.githubRepoId === null ||
    !Number.isSafeInteger(match.repository.githubRepoId)
  )
    throw new McpProxyError(
      fullName ? 403 : 404,
      fullName
        ? 'GitHub target must be an active connected repository on the configured app'
        : 'No active connected GitHub repository found for the configured app',
    );
  return {
    ...match,
    repository: {
      ...match.repository,
      githubRepoId: match.repository.githubRepoId,
    },
    appCredentials,
  };
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
      let userId: string | undefined;
      if (auth.tokenType === 'auth') {
        userId = await resolveActingUserId(auth);
        const actor = await db.query.users.findFirst({
          where: and(eq(users.id, userId), isNull(users.deletedAt)),
          columns: { id: true },
        });
        if (!actor)
          throw new McpProxyError(
            403,
            'GitHub MCP requires an active Roomote member',
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
        // Repository access is deployment-scoped, matching the existing repository
        // helpers. Do not mistake a stored installation owner for a per-user ACL.
        const { repository, installation, appCredentials } =
          await resolveRepository(`${args.owner}/${args.repo}`);
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
      // Only protocol/discovery traffic may choose a representative repository.
      // Every tools/call must resolve its own explicit target, without fallback.
      const target = name
        ? getReadTarget(name, rpc?.params?.arguments)
        : undefined;
      const { repository, installation, appCredentials } =
        await resolveRepository(
          target ? `${target.owner}/${target.repo}` : undefined,
        );
      const githubToken = await createGitHubToken(
        {
          type: 'installationId',
          installationId: installation.id,
          repositoryIds: [repository.githubRepoId],
        },
        appCredentials,
      );

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
