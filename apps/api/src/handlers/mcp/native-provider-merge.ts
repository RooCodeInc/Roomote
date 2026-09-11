import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, db, eq, isNull, repositories, users } from '@roomote/db/server';
import {
  getAdoPullRequest,
  mergeAdoPullRequest,
  parseAdoRepositoryFullName,
  resolveAdoInstanceHost,
  resolveAdoToken,
  type AdoPullRequestDetails,
} from '@roomote/ado';
import {
  getGiteaPullRequest,
  mergeGiteaPullRequest,
  resolveGiteaBaseUrl,
  resolveGiteaInstanceHost,
  resolveGiteaToken,
  type GiteaPullRequestDetails,
} from '@roomote/gitea';
import { z } from 'zod';

import type { Variables } from '../../types';
import { McpProxyError, toMcpToolResult } from './proxy-utils';

const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-fA-F0-9]{40}$/);
type Provider = 'ado' | 'gitea';
type PullRequestDetails = AdoPullRequestDetails | GiteaPullRequestDetails;

async function authorize(
  auth: Variables['authContext'],
  provider: Provider,
  host: string,
  fullName?: string,
) {
  if (!auth) throw new McpProxyError(401, 'Authentication required');
  if (auth.tokenType !== 'auth' || 'runId' in auth || !auth.userId)
    throw new McpProxyError(
      403,
      `${provider === 'ado' ? 'Azure DevOps' : 'Gitea'} MCP requires a Session user auth token`,
    );
  const member = await db.query.users.findFirst({
    where: and(eq(users.id, auth.userId), isNull(users.deletedAt)),
    columns: { id: true, role: true },
  });
  if (!member || !['admin', 'member'].includes(member.role))
    throw new McpProxyError(403, 'Current deployment membership required');
  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, provider),
      eq(repositories.host, host),
      eq(repositories.isActive, true),
      fullName === undefined ? undefined : eq(repositories.fullName, fullName),
    ),
    columns: { id: true, fullName: true, externalRepoId: true },
  });
  if (!repository?.externalRepoId)
    throw new McpProxyError(
      403,
      `Active connected ${provider === 'ado' ? 'Azure DevOps' : 'Gitea'} repository required`,
    );
  return {
    member,
    repository: { ...repository, externalRepoId: repository.externalRepoId },
  };
}

function createNativeProviderMergeMcp(provider: Provider) {
  const label = provider === 'ado' ? 'Azure DevOps' : 'Gitea';
  const repositoryFullName =
    provider === 'ado'
      ? z.string().regex(/^[^/]+\/[^/]+\/[^/]+$/)
      : z.string().regex(/^[\w.-]+\/[\w.-]+$/);
  const resolveHost =
    provider === 'ado' ? resolveAdoInstanceHost : resolveGiteaInstanceHost;
  const app = new Hono<{ Variables: Variables }>();
  app.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
    try {
      const auth = c.get('authContext');
      const host = await resolveHost();
      await authorize(auth, provider, host);
      const server = new McpServer({
        name: `roomote-${provider}-merge-mcp`,
        version: '1.0.0',
      });
      const base = { repositoryFullName, pullRequestNumber: number };
      server.registerTool(
        'get_pull_request',
        {
          description: `Read a ${label} pull request by number.`,
          inputSchema: z.object(base).strict(),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input) => {
          try {
            return toMcpToolResult({
              result: await readAndAuthorizePullRequest({
                auth,
                provider,
                host,
                ...input,
              }),
            });
          } catch (error) {
            return toolError(error, label);
          }
        },
      );
      server.registerTool(
        'merge_pull_request',
        {
          description: `Merge an open ${label} pull request at the expected head SHA. Provider branch protections and permissions apply.`,
          inputSchema: z
            .object({
              ...base,
              expectedHeadSha: sha,
              mergeMethod:
                provider === 'ado'
                  ? z
                      .enum([
                        'noFastForward',
                        'squash',
                        'rebase',
                        'rebaseMerge',
                      ])
                      .optional()
                  : z
                      .enum(['merge', 'rebase', 'rebase-merge', 'squash'])
                      .optional(),
            })
            .strict(),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          },
        },
        async (input) => {
          try {
            const before = await readAndAuthorizePullRequest({
              auth,
              provider,
              host,
              repositoryFullName: input.repositoryFullName,
              pullRequestNumber: input.pullRequestNumber,
            });
            const currentHead =
              provider === 'ado'
                ? (before as AdoPullRequestDetails).lastMergeSourceCommit
                    ?.commitId
                : (before as GiteaPullRequestDetails).head?.sha;
            const open =
              provider === 'ado'
                ? (before as AdoPullRequestDetails).status === 'active'
                : (before as GiteaPullRequestDetails).state === 'open' &&
                  (before as GiteaPullRequestDetails).merged !== true;
            if (
              !open ||
              currentHead?.toLowerCase() !== input.expectedHeadSha.toLowerCase()
            )
              throw new McpProxyError(
                409,
                'Pull request is not open at the expected head SHA. Read it again before merging.',
              );
            const { member, repository } = await authorize(
              auth,
              provider,
              host,
              input.repositoryFullName,
            );
            console.info(
              JSON.stringify({
                event: 'source_control_mcp_merge_authorized',
                provider,
                userId: member.id,
                repositoryId: repository.id,
                repositoryFullName: repository.fullName,
                targetNumber: input.pullRequestNumber,
              }),
            );
            let mergeError: unknown;
            try {
              if (provider === 'ado') {
                const token = await resolveAdoToken();
                if (!token) throw new Error('Azure DevOps token unavailable');
                const { organization } = parseAdoRepositoryFullName(
                  repository.fullName,
                );
                await mergeAdoPullRequest({
                  repositoryId: repository.externalRepoId,
                  pullRequestNumber: input.pullRequestNumber,
                  expectedHeadSha: input.expectedHeadSha,
                  mergeStrategy: input.mergeMethod as
                    | 'noFastForward'
                    | 'squash'
                    | 'rebase'
                    | 'rebaseMerge'
                    | undefined,
                  token,
                  organization,
                });
              } else {
                const [token, baseUrl] = await Promise.all([
                  resolveGiteaToken(),
                  resolveGiteaBaseUrl(),
                ]);
                if (!token || !baseUrl)
                  throw new Error('Gitea credentials unavailable');
                await mergeGiteaPullRequest({
                  repositoryFullName: repository.fullName,
                  pullRequestNumber: input.pullRequestNumber,
                  expectedHeadSha: input.expectedHeadSha,
                  mergeMethod: input.mergeMethod as
                    | 'merge'
                    | 'rebase'
                    | 'rebase-merge'
                    | 'squash'
                    | undefined,
                  token,
                  baseUrl,
                });
              }
            } catch (error) {
              mergeError = error;
            }
            const verified = await readAndAuthorizePullRequest({
              auth,
              provider,
              host,
              repositoryFullName: input.repositoryFullName,
              pullRequestNumber: input.pullRequestNumber,
            });
            const merged =
              provider === 'ado'
                ? (verified as AdoPullRequestDetails).status === 'completed'
                : (verified as GiteaPullRequestDetails).merged === true;
            if (!merged) {
              if (mergeError) throw mergeError;
              throw new McpProxyError(
                409,
                `${label} accepted the merge but has not confirmed completion. Read the pull request again before retrying.`,
              );
            }
            return toMcpToolResult({ result: verified });
          } catch (error) {
            return toolError(error, label);
          }
        },
      );
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
                : `${label} MCP unavailable`,
          },
        },
        { status: error instanceof McpProxyError ? error.httpStatus : 500 },
      );
    }
  });
  return app;
}

async function readAndAuthorizePullRequest({
  auth,
  provider,
  host,
  repositoryFullName,
  pullRequestNumber,
}: {
  auth: Variables['authContext'];
  provider: Provider;
  host: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}): Promise<PullRequestDetails> {
  const { repository } = await authorize(
    auth,
    provider,
    host,
    repositoryFullName,
  );
  if (provider === 'ado') {
    const token = await resolveAdoToken();
    if (!token) throw new McpProxyError(403, 'Azure DevOps token unavailable');
    const { organization } = parseAdoRepositoryFullName(repository.fullName);
    const details = await getAdoPullRequest({
      repositoryId: repository.externalRepoId,
      pullRequestNumber,
      token,
      organization,
    });
    if (
      details.pullRequestId !== pullRequestNumber ||
      details.repository?.id !== repository.externalRepoId
    )
      throw new McpProxyError(
        403,
        'Azure DevOps pull request identity mismatch',
      );
    return details;
  }
  const [token, baseUrl] = await Promise.all([
    resolveGiteaToken(),
    resolveGiteaBaseUrl(),
  ]);
  if (!token || !baseUrl)
    throw new McpProxyError(403, 'Gitea credentials unavailable');
  const details = await getGiteaPullRequest({
    repositoryFullName,
    pullRequestNumber,
    token,
    baseUrl,
  });
  if (
    details.number !== pullRequestNumber ||
    String(details.base?.repo?.id) !== repository.externalRepoId ||
    details.base?.repo?.full_name !== repository.fullName
  )
    throw new McpProxyError(403, 'Gitea pull request identity mismatch');
  return details;
}

function toolError(error: unknown, label: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text:
          error instanceof McpProxyError
            ? error.message
            : `${label} operation failed or returned an invalid response`,
      },
    ],
  };
}

export const adoMergeMcp = createNativeProviderMergeMcp('ado');
export const giteaMergeMcp = createNativeProviderMergeMcp('gitea');
