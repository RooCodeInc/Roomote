import { createGitHubToken } from '@roomote/auth';
import { type TaskRun } from '@roomote/db/server';
import { createGiteaIssueComment } from '@roomote/gitea';
import { getOctokit } from '@roomote/github';
import { createGitLabIssueNote } from '@roomote/gitlab';
import {
  getSourceControlProviderLabel,
  resolveSourceControlHostFromPayload,
  resolveSourceControlProviderFromPayload,
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';

import { requestSourceControlJson } from '../pull-requests/source-control-pull-request-http';
import {
  resolveGiteaProviderContext,
  resolveGitLabProviderContext,
} from '../pull-requests/source-control-pull-request-provider-context';
import {
  assertRepositoryInTaskRunScope,
  buildApiUrl,
  buildGitLabTokenHeader,
  getPayloadRecord,
  resolveRepositoryRow,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from '../pull-requests/source-control-pull-request-shared';

const ISSUE_PROVIDERS = ['github', 'gitlab', 'gitea'] as const;
type IssueProvider = (typeof ISSUE_PROVIDERS)[number];

const MAX_COMMENT_PAGES = 20;
const COMMENTS_PER_PAGE = 100;

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

const gitLabIssueSchema = z
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

const gitLabIssueNoteSchema = z
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

const giteaIssueSchema = z
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

const giteaIssueCommentSchema = z
  .object({
    id: z.number(),
    body: z.string(),
    created_at: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    user: z.object({ login: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export async function manageSourceControlIssueForTaskRun({
  taskRun,
  input,
  fetchImpl = fetch,
}: {
  taskRun: TaskRun;
  input: SourceControlIssueInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlIssueResult> {
  const payload = getPayloadRecord(taskRun.payload);
  const payloadProvider = resolveSourceControlProviderFromPayload(payload);
  const provider = input.sourceControlProvider ?? payloadProvider;

  if (provider !== payloadProvider) {
    throw new SourceControlIssueError(
      400,
      `Source control provider mismatch: task uses ${getSourceControlProviderLabel(
        payloadProvider,
      )}, but request specified ${getSourceControlProviderLabel(provider)}.`,
    );
  }

  if (!isIssueProvider(provider)) {
    throw new SourceControlIssueError(
      400,
      `${getSourceControlProviderLabel(provider)} issue operations are not supported.`,
    );
  }

  await assertRepositoryInTaskRunScope(taskRun, input.repositoryFullName);

  const repository = await resolveRepositoryRow({
    provider,
    repositoryFullName: input.repositoryFullName,
    host: resolveSourceControlHostFromPayload(payload),
  });

  switch (input.action) {
    case 'get_issue':
      return getIssue({
        repository,
        provider,
        issueNumber: input.issueNumber,
        fetchImpl,
      });
    case 'list_issue_comments':
      return listIssueComments({
        repository,
        provider,
        issueNumber: input.issueNumber,
        fetchImpl,
      });
    case 'create_issue_comment':
      return createIssueComment({
        repository,
        provider,
        issueNumber: input.issueNumber,
        body: input.body!,
      });
  }
}

function isIssueProvider(
  provider: SourceControlProvider,
): provider is IssueProvider {
  return ISSUE_PROVIDERS.includes(provider as IssueProvider);
}

async function getIssue({
  repository,
  provider,
  issueNumber,
  fetchImpl,
}: {
  repository: RepositoryRow;
  provider: IssueProvider;
  issueNumber: number;
  fetchImpl: FetchImpl;
}): Promise<SourceControlIssueDetailsResult> {
  switch (provider) {
    case 'github': {
      const { octokit, owner, repo } =
        await createGitHubIssueClient(repository);
      const { data } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      if (data.pull_request) {
        throw new SourceControlIssueError(
          400,
          'The requested issue is a pull request.',
        );
      }

      return {
        success: true,
        action: 'get_issue',
        provider,
        repositoryFullName: repository.fullName,
        number: data.number,
        url: data.html_url,
        title: data.title,
        body: data.body ?? '',
        state: data.state === 'open' ? 'open' : 'closed',
        author: data.user?.login ?? null,
        labels: data.labels
          .map((label) =>
            typeof label === 'string' ? label : (label.name ?? ''),
          )
          .filter(Boolean),
        warnings: [],
      };
    }
    case 'gitlab': {
      const { projectId, token, apiBaseUrl } =
        await resolveGitLabProviderContext(repository, 'read', 'GitLab issues');
      const issue = await requestSourceControlJson({
        fetchImpl,
        method: 'GET',
        url: buildApiUrl(
          apiBaseUrl,
          `/projects/${encodeURIComponent(projectId)}/issues/${issueNumber}`,
          {},
        ),
        tokenHeader: buildGitLabTokenHeader(token),
        schema: gitLabIssueSchema,
        acceptedStatuses: [200],
      });

      return {
        success: true,
        action: 'get_issue',
        provider,
        repositoryFullName: repository.fullName,
        number: issue.iid,
        url: issue.web_url,
        title: issue.title,
        body: issue.description ?? '',
        state: issue.state === 'opened' ? 'open' : 'closed',
        author: issue.author?.username ?? null,
        labels: issue.labels ?? [],
        warnings: [],
      };
    }
    case 'gitea': {
      const { apiBaseUrl, owner, repo, token } =
        await resolveGiteaProviderContext(repository, 'read', 'Gitea issues');
      const issue = await requestSourceControlJson({
        fetchImpl,
        method: 'GET',
        url: buildApiUrl(
          apiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
          {},
        ),
        tokenHeader: { name: 'Authorization', value: `token ${token}` },
        schema: giteaIssueSchema,
        acceptedStatuses: [200],
      });

      if (issue.pull_request) {
        throw new SourceControlIssueError(
          400,
          'The requested issue is a pull request.',
        );
      }

      return {
        success: true,
        action: 'get_issue',
        provider,
        repositoryFullName: repository.fullName,
        number: issue.number,
        url:
          issue.html_url ??
          `${repository.htmlUrl.replace(/\/$/, '')}/issues/${issue.number}`,
        title: issue.title,
        body: issue.body ?? '',
        state: issue.state === 'open' ? 'open' : 'closed',
        author: issue.user?.login ?? null,
        labels: (issue.labels ?? [])
          .map((label) => label.name ?? '')
          .filter(Boolean),
        warnings: [],
      };
    }
  }
}

async function listIssueComments({
  repository,
  provider,
  issueNumber,
  fetchImpl,
}: {
  repository: RepositoryRow;
  provider: IssueProvider;
  issueNumber: number;
  fetchImpl: FetchImpl;
}): Promise<SourceControlIssueCommentsResult> {
  switch (provider) {
    case 'github': {
      const { octokit, owner, repo } =
        await createGitHubIssueClient(repository);
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: COMMENTS_PER_PAGE,
        },
      );

      return {
        success: true,
        action: 'list_issue_comments',
        provider,
        repositoryFullName: repository.fullName,
        number: issueNumber,
        comments: comments.map((comment) => ({
          id: String(comment.id),
          author: comment.user?.login ?? null,
          body: comment.body ?? '',
          createdAt: comment.created_at ?? null,
          url: comment.html_url ?? null,
        })),
        warnings: [],
      };
    }
    case 'gitlab': {
      const { projectId, token, apiBaseUrl } =
        await resolveGitLabProviderContext(repository, 'read', 'GitLab issues');
      const notes = await fetchPaginated({
        fetchImpl,
        apiBaseUrl,
        path: `/projects/${encodeURIComponent(projectId)}/issues/${issueNumber}/notes`,
        tokenHeader: buildGitLabTokenHeader(token),
        schema: gitLabIssueNoteSchema,
      });

      return {
        success: true,
        action: 'list_issue_comments',
        provider,
        repositoryFullName: repository.fullName,
        number: issueNumber,
        comments: notes
          .filter((note) => !note.system)
          .map((note) => ({
            id: String(note.id),
            author: note.author?.username ?? null,
            body: note.body,
            createdAt: note.created_at ?? null,
            url: `${repository.htmlUrl.replace(/\/$/, '')}/-/issues/${issueNumber}#note_${note.id}`,
          })),
        warnings: [],
      };
    }
    case 'gitea': {
      const { apiBaseUrl, owner, repo, token } =
        await resolveGiteaProviderContext(repository, 'read', 'Gitea issues');
      const comments = await fetchPaginated({
        fetchImpl,
        apiBaseUrl,
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
        tokenHeader: { name: 'Authorization', value: `token ${token}` },
        schema: giteaIssueCommentSchema,
      });

      return {
        success: true,
        action: 'list_issue_comments',
        provider,
        repositoryFullName: repository.fullName,
        number: issueNumber,
        comments: comments.map((comment) => ({
          id: String(comment.id),
          author: comment.user?.login ?? null,
          body: comment.body,
          createdAt: comment.created_at ?? null,
          url: comment.html_url ?? null,
        })),
        warnings: [],
      };
    }
  }
}

async function createIssueComment({
  repository,
  provider,
  issueNumber,
  body,
}: {
  repository: RepositoryRow;
  provider: IssueProvider;
  issueNumber: number;
  body: string;
}): Promise<SourceControlIssueCommentWriteResult> {
  switch (provider) {
    case 'github': {
      const { octokit, owner, repo } =
        await createGitHubIssueClient(repository);
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });

      return buildCommentWriteResult({
        provider,
        repository,
        issueNumber,
        commentId: data.id,
        url: data.html_url ?? null,
      });
    }
    case 'gitlab': {
      const { projectId, token, apiBaseUrl } =
        await resolveGitLabProviderContext(
          repository,
          'write',
          'GitLab issues',
        );
      const comment = await createGitLabIssueNote({
        projectId,
        issueIid: issueNumber,
        body,
        token,
        apiBaseUrl,
      });

      return buildCommentWriteResult({
        provider,
        repository,
        issueNumber,
        commentId: comment.id,
        url: `${repository.htmlUrl.replace(/\/$/, '')}/-/issues/${issueNumber}#note_${comment.id}`,
      });
    }
    case 'gitea': {
      const { apiBaseUrl, baseUrl, token } = await resolveGiteaProviderContext(
        repository,
        'write',
        'Gitea issues',
      );
      const comment = await createGiteaIssueComment({
        repositoryFullName: repository.fullName,
        issueNumber,
        body,
        token,
        baseUrl,
        apiBaseUrl,
      });

      return buildCommentWriteResult({
        provider,
        repository,
        issueNumber,
        commentId: comment.id,
        url: null,
      });
    }
  }
}

function buildCommentWriteResult({
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

async function createGitHubIssueClient(repository: RepositoryRow): Promise<{
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

async function fetchPaginated<T>({
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
