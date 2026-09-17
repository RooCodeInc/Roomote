import {
  getAllowedRouterMcpToolNames,
  getRouterMcpUpstreamConstraints,
  type RouterMcpServerId,
} from '@roomote/cloud-agents/router-mcp-policy';
import {
  createGitHubToken,
  GitHubUserTokenError,
  resolveGitHubUserAccessToken,
  resolveRuntimeGitHubAppCredentials,
  type GitHubAppCredentials,
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
  'merge_pull_request',
  'add_issue_comment',
  'add_reply_to_pull_request_comment',
];
/**
 * Gist tools act on the member's own GitHub account, so they run under the
 * member's linked-account token; an installation token cannot reach gists.
 * Updates are allowed because GitHub keeps every revision of a gist.
 */
const accountGistToolNames = ['create_gist', 'get_gist', 'update_gist'];
/**
 * A member's gists are personal and often unrelated to work, and Session
 * transcripts are visible across the deployment. Roomote works only with a
 * gist it created or one the member points it at: it never lists existing
 * gists, and never deletes one, which GitHub cannot undo.
 */
const withheldGistToolNames = ['list_gists', 'delete_gist'];
const gistArgs = z.object({
  filename: z.string().min(1),
  content: z.string(),
  description: z.string().optional(),
  public: z.boolean(),
});

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

async function hasLinkedGitHubAccount(
  auth: Parameters<typeof resolveActingUserId>[0],
  knownUserId: string | undefined,
): Promise<boolean> {
  try {
    const userId = knownUserId ?? (await resolveActingUserId(auth));
    return Boolean(await resolveGitHubUserAccessToken(userId));
  } catch (error) {
    // Linked but needing reauthorization still counts as linked; a run with
    // no human actor does not.
    return error instanceof GitHubUserTokenError;
  }
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
    // GitHub answers each request on its own. With no session, the
    // credential can differ per request (installation token for repository
    // tools, the member's account token for gists) without GitHub rejecting
    // the later one as belonging to someone else's session.
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
      if (name && withheldGistToolNames.includes(name))
        throw new McpProxyError(
          403,
          'Roomote does not list or delete gists. Share the link to a specific gist to work with it.',
        );
      if (name && accountGistToolNames.includes(name)) {
        if (
          name === 'create_gist' &&
          !gistArgs.safeParse(toolArguments).success
        ) {
          throw new McpProxyError(
            400,
            'GitHub gist creation requires filename, content, and an explicit public boolean. Use false for a secret gist, which is link-accessible rather than private.',
          );
        }
        userId ??= await resolveActingUserId(auth);
        if (auth.tokenType === 'run') {
          const actor = await db.query.users.findFirst({
            where: and(eq(users.id, userId), isNull(users.deletedAt)),
            columns: { id: true },
          });
          if (!actor)
            throw new McpProxyError(
              403,
              'GitHub gist creation requires an active Roomote member',
            );
        }
        let token: string | null;
        try {
          token = await resolveGitHubUserAccessToken(userId);
        } catch (error) {
          if (error instanceof GitHubUserTokenError) {
            throw new McpProxyError(
              error.reauthorizationRequired ? 403 : 502,
              error.message,
            );
          }
          throw error;
        }
        if (!token) {
          throw new McpProxyError(
            403,
            'Link your GitHub account under Settings > Linked Accounts before using gists.',
          );
        }
        return {
          authHeader: token,
          // Members are not held to the coding-task allowlist, which only
          // names create_gist.
          ...(auth.tokenType === 'auth' ? { allowedToolNames: null } : {}),
          extraHeaders: buildRouterGitHubHeaders(false),
        };
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
      // A gist is created under the member's linked GitHub account, so a
      // member without one is not offered the tool. An expired link keeps it
      // listed: calling it is how the member learns to reconnect.
      const gistUnavailable =
        rpc?.method === 'tools/list' &&
        !(await hasLinkedGitHubAccount(auth, userId));
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
          disabledToolNames: [
            ...withheldGistToolNames,
            ...(gistUnavailable ? accountGistToolNames : []),
          ],
          extraHeaders: { 'X-MCP-Readonly': 'false', 'X-MCP-Toolsets': 'all' },
        };
      }

      // A coding task writes through its own checkout and `gh`; on this path
      // it reads, plus the account-scoped gist handled above.
      return {
        authHeader,
        ...responseBounds,
        disabledToolNames: [
          ...writeToolNames,
          ...(gistUnavailable ? accountGistToolNames : []),
        ],
        // Discovery is not pinned read-only so the gist tool stays listed;
        // every call is.
        extraHeaders: buildRouterGitHubHeaders(isCall),
      };
    },
  });
}
