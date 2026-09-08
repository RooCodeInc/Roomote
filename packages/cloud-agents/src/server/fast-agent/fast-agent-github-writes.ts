import { createGitHubToken } from '@roomote/auth';
import {
  and,
  db,
  desc,
  eq,
  githubInstallations,
  githubUserMappings,
  isNull,
  repositories,
  sql,
} from '@roomote/db/server';
import { getOctokit } from '@roomote/github';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { McpToolDefinition } from '../mcp-tool-client';

const repositoryShape = {
  owner: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
    .max(100),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .max(100),
};
const updatePullRequestSchema = z
  .object({
    ...repositoryShape,
    pullNumber: z.number().int().positive(),
    title: z.string().min(1).max(256).optional(),
    body: z.string().max(65_536).optional(),
    state: z.enum(['open', 'closed']).optional(),
  })
  .strict()
  .refine(
    (args) =>
      args.title !== undefined ||
      args.body !== undefined ||
      args.state !== undefined,
    'Provide at least one of title, body, or state.',
  );
const addIssueCommentSchema = z
  .object({
    ...repositoryShape,
    issue_number: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
  })
  .strict();

// These execute locally, never through the deployment-wide read-only MCP proxy.
export const FAST_GITHUB_WRITE_TOOLS: McpToolDefinition[] = [
  {
    name: 'update_pull_request',
    description:
      "Update a GitHub pull request title, body, or state (open/closed). Closing and reopening are supported; merging, base changes, and branch deletion are not. Requires an active connected repository and the requesting user's linked GitHub account to have write access.",
    inputSchema: zodToJsonSchema(updatePullRequestSchema),
  },
  {
    name: 'add_issue_comment',
    description:
      "Add a comment to a GitHub issue or pull request. Requires an active connected repository and the requesting user's linked GitHub account to have write access.",
    inputSchema: zodToJsonSchema(addIssueCommentSchema),
  },
];

export async function callFastGitHubWrite(options: {
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<unknown> {
  const { userId, toolName, signal } = options;
  if (!userId.trim())
    throw new Error('GitHub writes require a requesting user.');
  const args =
    toolName === 'update_pull_request'
      ? updatePullRequestSchema.parse(options.args)
      : toolName === 'add_issue_comment'
        ? addIssueCommentSchema.parse(options.args)
        : null;
  if (!args) throw new Error('That GitHub write tool is not supported.');

  const fullName = `${args.owner}/${args.repo}`;
  const [repository] = await db
    .select({
      installationId: repositories.installationId,
      githubRepoId: repositories.githubRepoId,
    })
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.sourceControlProvider, 'github'),
        eq(repositories.isActive, true),
        sql`lower(${repositories.fullName}) = ${fullName.toLowerCase()}`,
        isNull(githubInstallations.suspendedAt),
      ),
    )
    .limit(1);
  if (!repository?.installationId || !repository.githubRepoId) {
    throw new Error(
      'GitHub writes require an active connected repository with a non-suspended installation.',
    );
  }
  const actor = await db.query.githubUserMappings.findFirst({
    where: eq(githubUserMappings.userId, userId),
    orderBy: [desc(githubUserMappings.updatedAt)],
    columns: { githubLogin: true, githubUserId: true },
  });
  if (!actor)
    throw new Error(
      'Link your GitHub account before requesting GitHub writes.',
    );

  signal.throwIfAborted();
  const token = await createGitHubToken({
    type: 'installationId',
    installationId: repository.installationId,
    repositoryIds: [repository.githubRepoId],
  });
  const github = getOctokit(token);
  const request = { signal, redirect: 'error' as const };
  const target = { owner: args.owner, repo: args.repo, request };
  try {
    const { data: liveRepository } = await github.repos.get(target);
    if (
      liveRepository.id !== repository.githubRepoId ||
      liveRepository.full_name.toLowerCase() !== fullName.toLowerCase()
    ) {
      throw new Error(
        'The connected GitHub repository identity has changed. Reconnect it before writing.',
      );
    }
    const { data: permission } =
      await github.repos.getCollaboratorPermissionLevel({
        ...target,
        username: actor.githubLogin,
      });
    // Bind the verified OAuth identity by immutable ID, not a reusable login.
    if (
      permission.user?.id !== actor.githubUserId ||
      !(
        permission.user.permissions?.push === true ||
        ['write', 'maintain', 'admin'].includes(permission.permission)
      )
    ) {
      throw new Error(
        'Your linked GitHub account does not have write access to this repository.',
      );
    }

    signal.throwIfAborted();
    if ('pullNumber' in args) {
      const { data } = await github.pulls.update({
        ...target,
        pull_number: args.pullNumber,
        title: args.title,
        body: args.body,
        state: args.state,
      });
      return {
        number: data.number,
        url: data.html_url,
        state: data.state,
        title: data.title,
      };
    }
    const { data } = await github.issues.createComment({
      ...target,
      issue_number: args.issue_number,
      body: args.body,
    });
    return { id: data.id, url: data.html_url };
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? error.status
        : undefined;
    if (typeof status === 'number') {
      throw new Error(
        `GitHub API returned HTTP ${status}. The write was not confirmed; check repository access and GitHub App permissions before retrying.`,
      );
    }
    throw error;
  }
}
