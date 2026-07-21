import { createGitHubToken } from '@roomote/auth';
import { getOctokit } from '@roomote/github';
import {
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';

import { requestSourceControlJson } from '../pull-requests/source-control-pull-request-http';
import {
  buildApiUrl,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from '../pull-requests/source-control-pull-request-shared';

export const ISSUE_PROVIDERS = ['github', 'gitlab', 'gitea'] as const;
export type IssueProvider = (typeof ISSUE_PROVIDERS)[number];

const MAX_COMMENT_PAGES = 20;
export const COMMENTS_PER_PAGE = 100;

export const sourceControlIssueInputSchema = z
  .object({
    action: z.enum([
      'get_issue',
      'list_issue_comments',
      'create_issue_comment',
    ]),
    repositoryFullName: z.string().trim().min(1),
    issueNumber: z.number().int().positive(),
    body: z.string().optional(),
    sourceControlProvider: sourceControlProviderSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === 'create_issue_comment' && !input.body?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: 'body is required for create_issue_comment.',
      });
    }
  });

export type SourceControlIssueInput = z.infer<
  typeof sourceControlIssueInputSchema
>;

export type SourceControlIssueDetailsResult = {
  success: true;
  action: 'get_issue';
  provider: IssueProvider;
  repositoryFullName: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string | null;
  labels: string[];
  warnings: string[];
};

export type SourceControlIssueCommentsResult = {
  success: true;
  action: 'list_issue_comments';
  provider: IssueProvider;
  repositoryFullName: string;
  number: number;
  comments: Array<{
    id: string;
    author: string | null;
    body: string;
    createdAt: string | null;
    url: string | null;
  }>;
  warnings: string[];
};

export type SourceControlIssueCommentWriteResult = {
  success: true;
  action: 'create_issue_comment';
  provider: IssueProvider;
  repositoryFullName: string;
  number: number;
  commentId: string;
  url: string | null;
  warnings: string[];
};

export type SourceControlIssueResult =
  | SourceControlIssueDetailsResult
  | SourceControlIssueCommentsResult
  | SourceControlIssueCommentWriteResult;

export class SourceControlIssueError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'SourceControlIssueError';
  }
}

export type IssueOperationContext = {
  repository: RepositoryRow;
  provider: IssueProvider;
  issueNumber: number;
  fetchImpl: FetchImpl;
};

export const gitLabIssueSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    web_url: z.string(),
    author: z
      .object({ username: z.string().optional() })
      .passthrough()
      .optional(),
    labels: z.array(z.string()).optional(),
  })
  .passthrough();

export const gitLabIssueNoteSchema = z
  .object({
    id: z.number(),
    body: z.string(),
    created_at: z.string().nullable().optional(),
    system: z.boolean().optional(),
    author: z
      .object({ username: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const giteaIssueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    html_url: z.string().optional(),
    pull_request: z.unknown().optional(),
    user: z.object({ login: z.string().optional() }).passthrough().optional(),
    labels: z
      .array(z.object({ name: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export const giteaIssueCommentSchema = z
  .object({
    id: z.number(),
    body: z.string(),
    created_at: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    user: z.object({ login: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export function isIssueProvider(
  provider: SourceControlProvider,
): provider is IssueProvider {
  return ISSUE_PROVIDERS.includes(provider as IssueProvider);
}

export function buildCommentWriteResult({
  provider,
  repository,
  issueNumber,
  commentId,
  url,
}: {
  provider: IssueProvider;
  repository: RepositoryRow;
  issueNumber: number;
  commentId: string | number;
  url: string | null;
}): SourceControlIssueCommentWriteResult {
  return {
    success: true,
    action: 'create_issue_comment',
    provider,
    repositoryFullName: repository.fullName,
    number: issueNumber,
    commentId: String(commentId),
    url,
    warnings: [],
  };
}

export async function createGitHubIssueClient(
  repository: RepositoryRow,
): Promise<{
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
}> {
  if (!repository.installationId) {
    throw new SourceControlIssueError(
      400,
      `GitHub repository ${repository.fullName} is missing an installation id.`,
    );
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, 'github');
  const token = await createGitHubToken({
    type: 'installationId',
    installationId: repository.installationId,
  });

  return { octokit: getOctokit(token), owner, repo };
}

export async function fetchPaginated<T>({
  fetchImpl,
  apiBaseUrl,
  path,
  tokenHeader,
  schema,
}: {
  fetchImpl: FetchImpl;
  apiBaseUrl: string;
  path: string;
  tokenHeader: { name: string; value: string };
  schema: z.ZodType<T>;
}): Promise<T[]> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const pageItems = await requestSourceControlJson({
      fetchImpl,
      method: 'GET',
      url: buildApiUrl(apiBaseUrl, path, {
        page,
        per_page: COMMENTS_PER_PAGE,
        limit: COMMENTS_PER_PAGE,
      }),
      tokenHeader,
      schema: z.array(schema),
      acceptedStatuses: [200],
    });

    items.push(...pageItems);
    if (pageItems.length < COMMENTS_PER_PAGE) {
      break;
    }
  }

  return items;
}

export function throwIfPullRequest(pullRequestField: unknown): void {
  if (pullRequestField) {
    throw new SourceControlIssueError(
      400,
      'The requested issue is a pull request.',
    );
  }
}
