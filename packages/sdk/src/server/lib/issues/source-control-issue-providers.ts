import { createGiteaIssueComment } from '@roomote/gitea';
import { createGitLabIssueNote } from '@roomote/gitlab';

import { requestSourceControlJson } from '../pull-requests/source-control-pull-request-http';
import {
  resolveGiteaProviderContext,
  resolveGitLabProviderContext,
} from '../pull-requests/source-control-pull-request-provider-context';
import {
  buildApiUrl,
  buildGitLabTokenHeader,
  type FetchImpl,
  type RepositoryRow,
} from '../pull-requests/source-control-pull-request-shared';
import {
  buildCommentWriteResult,
  COMMENTS_PER_PAGE,
  createGitHubIssueClient,
  fetchPaginated,
  giteaIssueCommentSchema,
  giteaIssueSchema,
  gitLabIssueNoteSchema,
  gitLabIssueSchema,
  throwIfPullRequest,
  type IssueOperationContext,
  type IssueProvider,
  type SourceControlIssueCommentsResult,
  type SourceControlIssueCommentWriteResult,
  type SourceControlIssueDetailsResult,
} from './source-control-issue-shared';

type IssueProviderOperations = {
  getIssue: (
    ctx: IssueOperationContext,
  ) => Promise<SourceControlIssueDetailsResult>;
  listComments: (
    ctx: IssueOperationContext,
  ) => Promise<SourceControlIssueCommentsResult>;
  createComment: (
    ctx: IssueOperationContext & { body: string },
  ) => Promise<SourceControlIssueCommentWriteResult>;
  assertPlainIssue: (ctx: IssueOperationContext) => Promise<void>;
};

const githubOperations: IssueProviderOperations = {
  async getIssue({ repository, provider, issueNumber }) {
    const { octokit, owner, repo } = await createGitHubIssueClient(repository);
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    throwIfPullRequest(data.pull_request);

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
  },

  async listComments({ repository, provider, issueNumber }) {
    const { octokit, owner, repo } = await createGitHubIssueClient(repository);
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: COMMENTS_PER_PAGE,
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
        body: comment.body ?? '',
        createdAt: comment.created_at ?? null,
        url: comment.html_url ?? null,
      })),
      warnings: [],
    };
  },

  async createComment({ repository, provider, issueNumber, body }) {
    const { octokit, owner, repo } = await createGitHubIssueClient(repository);
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
  },

  async assertPlainIssue({ repository, issueNumber }) {
    const { octokit, owner, repo } = await createGitHubIssueClient(repository);
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    throwIfPullRequest(data.pull_request);
  },
};

const gitLabOperations: IssueProviderOperations = {
  async getIssue({ repository, provider, issueNumber, fetchImpl }) {
    const { projectId, token, apiBaseUrl } = await resolveGitLabProviderContext(
      repository,
      'read',
      'GitLab issues',
    );
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
  },

  async listComments({ repository, provider, issueNumber, fetchImpl }) {
    const { projectId, token, apiBaseUrl } = await resolveGitLabProviderContext(
      repository,
      'read',
      'GitLab issues',
    );
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
  },

  async createComment({ repository, provider, issueNumber, body }) {
    const { projectId, token, apiBaseUrl } = await resolveGitLabProviderContext(
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
  },

  async assertPlainIssue() {
    // GitLab issues and merge requests use separate number spaces.
  },
};

const giteaOperations: IssueProviderOperations = {
  async getIssue({ repository, provider, issueNumber, fetchImpl }) {
    const issue = await fetchGiteaIssue({ repository, issueNumber, fetchImpl });

    throwIfPullRequest(issue.pull_request);

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
  },

  async listComments({ repository, provider, issueNumber, fetchImpl }) {
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
  },

  async createComment({ repository, provider, issueNumber, body }) {
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
  },

  async assertPlainIssue({ repository, issueNumber, fetchImpl }) {
    const issue = await fetchGiteaIssue({ repository, issueNumber, fetchImpl });
    throwIfPullRequest(issue.pull_request);
  },
};

const ISSUE_PROVIDER_OPERATIONS: Record<
  IssueProvider,
  IssueProviderOperations
> = {
  github: githubOperations,
  gitlab: gitLabOperations,
  gitea: giteaOperations,
};

export function getIssueProviderOperations(
  provider: IssueProvider,
): IssueProviderOperations {
  return ISSUE_PROVIDER_OPERATIONS[provider];
}

async function fetchGiteaIssue({
  repository,
  issueNumber,
  fetchImpl,
}: {
  repository: RepositoryRow;
  issueNumber: number;
  fetchImpl: FetchImpl;
}) {
  const { apiBaseUrl, owner, repo, token } = await resolveGiteaProviderContext(
    repository,
    'read',
    'Gitea issues',
  );

  return requestSourceControlJson({
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
}
