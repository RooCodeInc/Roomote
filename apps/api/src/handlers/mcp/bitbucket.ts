import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, db, eq, isNull, repositories, users } from '@roomote/db/server';
import {
  createBitbucketRepositoryClient,
  getBitbucketOAuthConnection,
  resolveBitbucketOAuthAccessToken,
  stripUuidBraces,
  type BitbucketRepositoryClient,
} from '@roomote/bitbucket';
import type { Variables } from '../../types';
import { McpProxyError, toMcpToolResult } from './proxy-utils';

const repository = z
  .string()
  .max(511)
  .regex(/^[\w.-]+\/[\w.-]+$/);
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const page = z.number().int().min(1).max(100).optional();
const ref = z.string().min(1).max(255);
const path = z.string().max(2048);
const base = { repositoryFullName: repository };
const pr = { ...base, pullRequestNumber: number };

async function authorize(auth: Variables['authContext'], fullName?: string) {
  if (!auth) throw new McpProxyError(401, 'Authentication required');
  if (auth.tokenType !== 'auth' || 'runId' in auth || !auth.userId) {
    throw new McpProxyError(
      403,
      'Bitbucket MCP requires a Session user auth token',
    );
  }
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, auth.userId), isNull(users.deletedAt)),
    columns: { id: true, role: true },
  });
  if (!user || !['admin', 'member'].includes(user.role)) {
    throw new McpProxyError(403, 'Current deployment membership required');
  }
  const connected = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'bitbucket'),
      eq(repositories.host, 'bitbucket.org'),
      eq(repositories.isActive, true),
      fullName === undefined ? undefined : eq(repositories.fullName, fullName),
    ),
    columns: { fullName: true, externalRepoId: true },
  });
  if (!connected?.externalRepoId) {
    throw new McpProxyError(
      403,
      'Active connected Bitbucket Cloud repository required',
    );
  }
  const connection = await getBitbucketOAuthConnection();
  if (connection?.status !== 'active') {
    throw new McpProxyError(403, 'Active Bitbucket OAuth connection required');
  }
  return connected;
}

function assertRepository(
  value: unknown,
  connected: { fullName: string; externalRepoId: string | null },
) {
  const identity = z
    .object({ uuid: z.string().min(1), full_name: z.string() })
    .safeParse(value);
  if (
    !identity.success ||
    identity.data.full_name !== connected.fullName ||
    stripUuidBraces(identity.data.uuid).toLowerCase() !==
      stripUuidBraces(connected.externalRepoId ?? '').toLowerCase()
  ) {
    throw new McpProxyError(403, 'Bitbucket repository ownership mismatch');
  }
}

function createServer(auth: Variables['authContext']) {
  const server = new McpServer({
    name: 'roomote-bitbucket-mcp',
    version: '1.0.0',
  });
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    execute: (
      input: z.infer<z.ZodObject<S>>,
      client: BitbucketRepositoryClient,
      checkRepository: (value: unknown) => void,
    ) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.object(shape).strict(),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: true,
        },
      },
      async (input) => {
        try {
          const fullName = repository.parse(input.repositoryFullName);
          const connected = await authorize(auth, fullName);
          // Resolve through the existing refresh coordinator on every call, never at discovery.
          const token = await resolveBitbucketOAuthAccessToken();
          if (!token)
            throw new McpProxyError(403, 'Bitbucket OAuth token unavailable');
          const client = createBitbucketRepositoryClient({
            repositoryFullName: fullName,
            token,
          });
          const checkRepository = (value: unknown) =>
            assertRepository(value, connected);
          checkRepository(await client.getRepository());
          if ('pullRequestNumber' in input) {
            const requestedNumber = number.parse(input.pullRequestNumber);
            const details = await client.getPullRequest(requestedNumber);
            if (details.id !== requestedNumber)
              throw new McpProxyError(403, 'Pull request identity mismatch');
            checkRepository(details.destination?.repository);
          }
          const result = await execute(input, client, checkRepository);
          // Do not reflect provider errors (which may contain credentials or payloads).
          return toMcpToolResult({ result });
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  error instanceof McpProxyError
                    ? error.message
                    : 'Bitbucket operation failed or returned an invalid response',
              },
            ],
          };
        }
      },
    );
  }
  register(
    'get_file',
    'Read a repository file (maximum 1 MiB).',
    { ...base, ref, path: path.min(1) },
    true,
    (input, client) => client.getFile(input.ref, input.path),
  );
  register(
    'list_directory',
    'Read one directory page (50 entries).',
    { ...base, ref, path: path.optional(), page },
    true,
    (input, client) => client.listDirectory(input.ref, input.path, input.page),
  );
  register(
    'search_code',
    'Search plain code terms within this repository only. Bitbucket code search is deprecated November 1, 2026; no fallback to unscoped search.',
    { ...base, terms: z.string().min(1).max(256), page },
    true,
    async (input, client, check) => {
      const result = await client.searchCode(input.terms, input.page);
      result.values.forEach((match) => check(match.file.commit.repository));
      return result;
    },
  );
  register(
    'list_commits',
    'Read one page of commit history, without creating commits.',
    { ...base, ref, page },
    true,
    async (input, client, check) => {
      const result = await client.listCommits(input.ref, input.page);
      result.values.forEach((commit) => check(commit.repository));
      return result;
    },
  );
  register(
    'get_commit',
    'Read commit details by hash.',
    { ...base, hash: z.string().regex(/^[a-fA-F0-9]{7,40}$/) },
    true,
    async (input, client, check) => {
      const result = await client.getCommit(input.hash);
      check(result.repository);
      return result;
    },
  );
  register(
    'get_pull_request',
    'Read a pull request by number.',
    pr,
    true,
    async (input, client, check) => {
      const result = await client.getPullRequest(input.pullRequestNumber);
      if (result.id !== input.pullRequestNumber)
        throw new McpProxyError(403, 'Pull request identity mismatch');
      check(result.destination?.repository);
      return result;
    },
  );
  register(
    'get_pull_request_diff',
    'Read a pull request diff (maximum 1 MiB).',
    pr,
    true,
    (input, client) => client.getPullRequestDiff(input.pullRequestNumber),
  );
  register(
    'list_pull_request_comments',
    'Read one page of pull request comments.',
    { ...pr, page },
    true,
    (input, client) =>
      client.listPullRequestComments(input.pullRequestNumber, input.page),
  );
  register(
    'update_pull_request',
    'Update only title and/or description by number. Cannot reopen or merge.',
    {
      ...pr,
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(65_536).optional(),
    },
    false,
    async (input, client, check) => {
      const result = await client.updatePullRequest(input.pullRequestNumber, {
        title: input.title,
        description: input.description,
      });
      check(result.destination?.repository);
      return result;
    },
  );
  register(
    'decline_pull_request',
    'Decline a pull request by number. Cannot reopen or merge.',
    pr,
    false,
    async (input, client, check) => {
      const result = await client.declinePullRequest(input.pullRequestNumber);
      check(result.destination?.repository);
      return result;
    },
  );
  register(
    'add_pull_request_comment',
    'Add a pull request comment or reply to a comment in this pull request.',
    {
      ...pr,
      body: z.string().min(1).max(65_536),
      parentCommentId: number.optional(),
    },
    false,
    async (input, client) => {
      if (input.parentCommentId !== undefined) {
        const parent = await client.getPullRequestComment(
          input.pullRequestNumber,
          input.parentCommentId,
        );
        const owner = z
          .object({
            id: number,
            links: z.object({ self: z.object({ href: z.string() }) }),
          })
          .safeParse(parent.pullrequest);
        const expected = `https://api.bitbucket.org/2.0/repositories/${input.repositoryFullName}/pullrequests/${input.pullRequestNumber}`;
        if (
          parent.id !== input.parentCommentId ||
          parent.deleted === true ||
          !owner.success ||
          owner.data.id !== input.pullRequestNumber ||
          owner.data.links.self.href !== expected
        ) {
          throw new McpProxyError(
            403,
            'Reply parent does not belong to this repository and pull request',
          );
        }
      }
      return client.createPullRequestComment(
        input.pullRequestNumber,
        input.body,
        input.parentCommentId,
      );
    },
  );
  return server;
}

export const bitbucketMcp = new Hono<{ Variables: Variables }>();
bitbucketMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  try {
    await authorize(c.get('authContext'));
    const server = createServer(c.get('authContext'));
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (error) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message:
            error instanceof McpProxyError
              ? error.message
              : 'Bitbucket MCP unavailable',
        },
      },
      { status: error instanceof McpProxyError ? error.httpStatus : 500 },
    );
  }
});
