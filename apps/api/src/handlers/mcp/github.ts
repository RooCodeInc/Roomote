import {
  getAllowedRouterMcpToolNames,
  getRouterMcpUpstreamConstraints,
  type RouterMcpServerId,
} from '@roomote/cloud-agents/router-mcp-policy';
import {
  createGitHubToken,
  resolveRuntimeGitHubAppCredentials,
  type GitHubAppCredentials,
} from '@roomote/auth';
import { Hono } from 'hono';
import { isUserToken } from '@roomote/types';
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
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { z } from 'zod';

import type { Variables } from '../../types';

import {
  callEnablePullRequestAutoMerge,
  ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
  enablePullRequestAutoMergeToolDefinition,
} from './github-auto-merge';
import {
  createMcpProxy,
  getJsonRpcMethod,
  getJsonRpcRequestId,
  getToolCallName,
  jsonRpcErrorResponse,
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
  'merge_pull_request',
  'add_issue_comment',
  'add_reply_to_pull_request_comment',
  ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
];
const unsupportedGistToolNames = [
  'create_gist',
  'get_gist',
  'list_gists',
  'update_gist',
  'delete_gist',
];

const ownerName = repositoryArgs.shape.owner;

/**
 * What a call is about, when its arguments say so: `owner`/`repo`, or an
 * unnegated, unquoted `repo:owner/name`, `org:name` or `user:name` search
 * qualifier. It only steers which installation's credential to use; GitHub
 * enforces what that credential can see, so a read is never refused for
 * lacking one.
 */
function getTargetHint(
  args: unknown,
): { owner: string; repo?: string } | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const direct = repositoryArgs.safeParse({
    owner: record.owner,
    repo: record.repo,
  });
  if (direct.success) return direct.data;
  if (typeof record.query === 'string') {
    // Whole tokens only, so a quoted or parenthesized qualifier never
    // matches, and a token negated with `-` or a preceding NOT is skipped:
    // excluding a repository must not route the search to its installation.
    const tokens = record.query.split(/\s+/).filter(Boolean);
    const positive = tokens.filter(
      (token, index) =>
        !token.startsWith('-') && !/^NOT$/i.test(tokens[index - 1] ?? ''),
    );
    for (const token of positive) {
      const repoMatch =
        /^repo:([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9_.-]+)$/.exec(token);
      const parsed = repoMatch
        ? repositoryArgs.safeParse({ owner: repoMatch[1], repo: repoMatch[2] })
        : null;
      if (parsed?.success) return parsed.data;
    }
    for (const token of positive) {
      const ownerMatch = /^(?:org|user):([a-zA-Z0-9][a-zA-Z0-9-]*)$/.exec(
        token,
      );
      if (ownerMatch) return { owner: ownerMatch[1]! };
    }
  }
  const owner = ownerName.safeParse(record.owner);
  return owner.success ? { owner: owner.data } : undefined;
}

/** GitHub caps `repository_ids` on an installation token request. */
const MAX_TOKEN_REPOSITORY_IDS = 500;
/**
 * Fast turns make many GitHub calls in a row; one token per installation,
 * reused for a few minutes, keeps the MCP session on a single identity.
 */
const INSTALLATION_TOKEN_MAX_AGE_MS = 10 * 60_000;

type ConnectedInstallation = {
  installation: typeof githubInstallations.$inferSelect;
  repositories: (typeof repositories.$inferSelect)[];
};

async function listConnectedInstallations(
  appCredentials: GitHubAppCredentials,
): Promise<ConnectedInstallation[]> {
  const rows = await db
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
      ),
    )
    .orderBy(githubInstallations.id, repositories.id);
  const byInstallation = new Map<string, ConnectedInstallation>();
  for (const row of rows) {
    const entry = byInstallation.get(row.installation.id) ?? {
      installation: row.installation,
      repositories: [],
    };
    entry.repositories.push(row.repository);
    byInstallation.set(row.installation.id, entry);
  }
  return [...byInstallation.values()];
}

/**
 * The same shape of credential a coding task gets: one installation token
 * covering every repository connected on that installation. The installation
 * is the one that owns the target when the call names a connected
 * repository, otherwise the first by a stable order. Picking is separate
 * from minting so a refused write never costs a token.
 */
async function pickInstallation(target?: { owner: string; repo?: string }) {
  const appCredentials = await resolveRuntimeGitHubAppCredentials();
  const installations = await listConnectedInstallations(appCredentials);
  const fullName = target?.repo
    ? `${target.owner}/${target.repo}`.toLowerCase()
    : undefined;
  const ownerPrefix = target ? `${target.owner.toLowerCase()}/` : undefined;
  const owning = fullName
    ? installations.find((entry) =>
        entry.repositories.some(
          (repository) => repository.fullName.toLowerCase() === fullName,
        ),
      )
    : undefined;
  // An owner alone (an `org:` search) still names an installation: the one
  // with a connected repository under that owner.
  const sameOwner =
    !owning && ownerPrefix
      ? installations.find((entry) =>
          entry.repositories.some((repository) =>
            repository.fullName.toLowerCase().startsWith(ownerPrefix),
          ),
        )
      : undefined;
  const chosen = owning ?? sameOwner ?? installations[0];
  if (!chosen)
    throw new McpProxyError(
      404,
      'No active connected GitHub repository found for the configured app',
    );
  return {
    appCredentials,
    chosen,
    connectedTarget: owning
      ? (owning.repositories.find(
          (repository) => repository.fullName.toLowerCase() === fullName,
        ) ?? null)
      : null,
  };
}

function mintInstallationToken(
  picked: Awaited<ReturnType<typeof pickInstallation>>,
): Promise<string> {
  // Always scoped. An unscoped installation token would also read private
  // repositories the App is installed on but the deployment never connected.
  // Past GitHub's id limit the target goes first so its call still works.
  const targetId = picked.connectedTarget?.githubRepoId;
  const repositoryIds = [
    ...(typeof targetId === 'number' ? [targetId] : []),
    ...picked.chosen.repositories
      .map((repository) => repository.githubRepoId)
      .filter((id): id is number => typeof id === 'number' && id !== targetId),
  ].slice(0, MAX_TOKEN_REPOSITORY_IDS);
  return createGitHubToken(
    {
      type: 'installationId',
      installationId: picked.chosen.installation.id,
      repositoryIds,
    },
    picked.appCredentials,
    { cache: true, maxCacheAgeMs: INSTALLATION_TOKEN_MAX_AGE_MS },
  );
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
  const proxy = createMcpProxy({
    name: 'GitHub',
    upstream: Env.GITHUB_MCP_SERVER_URL ?? DEFAULT_GITHUB_MCP_URL,
    allowAuthTokens: options?.allowAuthTokens,
    allowedToolNames,
    // GitHub answers each request on its own. With no session, repository
    // calls can select the installation that owns their target without a
    // prior request binding the upstream connection to another credential.
    statelessUpstream: true,
    resolveCredentials: async (auth, _params, request) => {
      if (Array.isArray(request))
        throw new McpProxyError(
          400,
          'GitHub MCP batch requests are not allowed',
        );
      const rpc = request as
        | { method?: string; params?: { name?: string; arguments?: unknown } }
        | undefined;
      const isCall = rpc?.method === 'tools/call';
      if (
        isCall &&
        (typeof rpc?.params?.name !== 'string' ||
          unsupportedGistToolNames.includes(rpc.params.name) ||
          (auth.tokenType === 'run' &&
            !allowedToolNames.includes(rpc.params.name)))
      ) {
        throw new McpProxyError(
          403,
          'GitHub MCP tool is not allowed on this endpoint',
        );
      }
      const name = isCall ? rpc?.params?.name : undefined;
      const toolArguments = isCall ? rpc?.params?.arguments : undefined;
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
      const isMember = auth.tokenType === 'auth';
      // A coding task writes through its own checkout and `gh`. Refused
      // before any token is minted.
      if (!isMember && name && writeToolNames.includes(name))
        throw new McpProxyError(
          403,
          'GitHub MCP writes require a user-scoped auth token',
        );
      const target = getTargetHint(toolArguments);
      const picked = await pickInstallation(target);
      // A call that is not about a connected repository can reach anything
      // public, an unscoped search included; bound what it may pull in.
      const responseBounds =
        isCall && !picked.connectedTarget
          ? { maxResponseBodyBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }
          : {};
      const authHeader = await mintInstallationToken(picked);

      if (isMember) {
        // A signed-in member gets what a coding task gets through `gh`: any
        // GitHub tool, under a token that reaches only the repositories the
        // deployment connected. GitHub and the App's permissions are the
        // boundary. The Session transcript already records every call.
        return {
          authHeader,
          ...responseBounds,
          allowedToolNames: null,
          disabledToolNames: unsupportedGistToolNames,
          extraHeaders: { 'X-MCP-Readonly': 'false', 'X-MCP-Toolsets': 'all' },
        };
      }

      // A coding task writes through its own checkout and `gh`; this path is
      // read-only.
      return {
        authHeader,
        ...responseBounds,
        disabledToolNames: writeToolNames,
        extraHeaders: buildRouterGitHubHeaders(isCall),
      };
    },
  });

  // GitHub's own MCP server has no auto-merge tool, so this endpoint answers
  // enable_pull_request_auto_merge in-process under the same member-only
  // write boundary as the proxied write tools, and lists it for members only.
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (c.req.method !== 'POST') {
      await next();
      return;
    }
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined);
    if (getToolCallName(body) === ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL) {
      return handleEnablePullRequestAutoMerge(c, body);
    }
    await next();
    if (getJsonRpcMethod(body) === 'tools/list') {
      c.res = await appendAutoMergeToolDefinition(c.res, c.get('authContext'));
    }
  });
  app.route('/', proxy);
  return app;
}

async function handleEnablePullRequestAutoMerge(
  c: {
    get: (key: 'authContext') => Variables['authContext'];
  },
  body: unknown,
): Promise<Response> {
  const requestId = getJsonRpcRequestId(body);
  const rawAuth = c.get('authContext');
  if (!rawAuth) {
    return jsonRpcErrorResponse(
      401,
      -32001,
      'Unauthorized: missing or invalid bearer token',
      requestId,
    );
  }
  // Writes on this endpoint require explicit human intent: a signed-in
  // member's user-scoped auth token, never a coding task's run token.
  if (!isUserToken(rawAuth)) {
    return jsonRpcErrorResponse(
      403,
      -32000,
      'GitHub MCP writes require a user-scoped auth token',
      requestId,
    );
  }

  try {
    const userId = await resolveActingUserId({
      userId: rawAuth.userId ?? null,
      tokenType: 'auth',
    });
    const actor = await db.query.users.findFirst({
      where: and(eq(users.id, userId), isNull(users.deletedAt)),
      columns: { id: true },
    });
    if (!actor) {
      throw new McpProxyError(
        403,
        'GitHub MCP requires an active Roomote member',
      );
    }

    const args = (body as { params?: { arguments?: unknown } }).params
      ?.arguments;
    const target = getTargetHint(args);
    const picked = await pickInstallation(target);
    if (!picked.connectedTarget) {
      throw new McpProxyError(
        403,
        'Active connected GitHub repository required',
      );
    }
    const token = await mintInstallationToken(picked);
    const pullNumber =
      args && typeof args === 'object' && 'pullNumber' in args
        ? (args as { pullNumber?: unknown }).pullNumber
        : undefined;
    console.info(
      JSON.stringify({
        event: 'source_control_mcp_auto_merge_authorized',
        provider: 'github',
        userId: actor.id,
        repositoryId: picked.connectedTarget.id,
        repositoryFullName: picked.connectedTarget.fullName,
        targetNumber: typeof pullNumber === 'number' ? pullNumber : undefined,
      }),
    );

    const result = await callEnablePullRequestAutoMerge({
      token,
      repositoryFullName: picked.connectedTarget.fullName,
      arguments: args,
    });
    return Response.json({ jsonrpc: '2.0', id: requestId, result });
  } catch (error) {
    if (error instanceof McpProxyError) {
      return jsonRpcErrorResponse(
        error.httpStatus,
        -32000,
        error.message,
        requestId,
      );
    }
    return jsonRpcErrorResponse(
      500,
      -32603,
      'GitHub auto-merge operation failed',
      requestId,
    );
  }
}

async function appendAutoMergeToolDefinition(
  response: Response,
  auth: Variables['authContext'],
): Promise<Response> {
  // Run tokens never see write tools; the tool is also absent upstream, so
  // there is nothing to hide for them here.
  if (!auth || !isUserToken(auth)) {
    return response;
  }
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json')
  ) {
    return response;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== 'object' || !('result' in payload)) {
    return response;
  }
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return response;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return response;
  if (
    tools.some(
      (tool) =>
        tool &&
        typeof tool === 'object' &&
        'name' in tool &&
        tool.name === ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
    )
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Response(
    JSON.stringify({
      ...payload,
      result: {
        ...(result as object),
        tools: [...tools, enablePullRequestAutoMergeToolDefinition],
      },
    }),
    { status: response.status, headers },
  );
}
