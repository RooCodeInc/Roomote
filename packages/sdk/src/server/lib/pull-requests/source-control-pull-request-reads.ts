import { createGitHubToken } from '@roomote/auth';
import {
  buildAdoOrganizationApiBaseUrl,
  resolveAdoBaseUrl,
  resolveAdoToken,
} from '@roomote/ado';
import {
  buildGiteaApiBaseUrl,
  resolveGiteaBaseUrl,
  resolveGiteaToken,
} from '@roomote/gitea';
import { getOctokit } from '@roomote/github';
import {
  buildGitLabApiBaseUrl,
  resolveGitLabBaseUrl,
  resolveGitLabToken,
} from '@roomote/gitlab';
import { type Run } from '@roomote/db/server';
import {
  buildPullRequestUrl,
  getSourceControlProviderLabel,
  resolveSourceControlProviderFromPayload,
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
  assertRepositoryInCloudJobScope,
  buildAdoBasicAuthHeader,
  buildApiUrl,
  formatResponseBody,
  getPayloadRecord,
  isDraftTitle,
  isGitLabDraft,
  parseAdoRepositoryFullName,
  resolveRepositoryRow,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';

const ADO_API_VERSION = '7.1';

export const sourceControlPullRequestReadInputSchema = z.object({
  action: z.enum(['get_pull_request', 'list_pull_request_comments']),
  repositoryFullName: z.string().trim().min(1),
  prNumber: z.number().int().positive(),
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type SourceControlPullRequestReadInput = z.infer<
  typeof sourceControlPullRequestReadInputSchema
>;

export type SourceControlPullRequestDetailsResult = {
  success: true;
  provider: SourceControlProvider;
  repositoryFullName: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  headSha: string | null;
  baseSha: string | null;
  author: string | null;
  /** Null when the provider has not computed mergeability or does not expose it. */
  mergeable: boolean | null;
  /** The provider's raw merge-state string, for honest reporting. */
  mergeStateDescription: string | null;
  /** True when the PR head lives in a different repository/fork than the base; null when the provider cannot say. */
  isCrossRepository: boolean | null;
  /** Full name of the head (source) repository when the provider exposes it. */
  headRepositoryFullName: string | null;
  warnings: string[];
};

type SourceControlPullRequestComment = {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
};

type SourceControlPullRequestCommentThread = {
  id: string;
  resolved: boolean | null;
  path: string | null;
  line: number | null;
  comments: SourceControlPullRequestComment[];
};

export type SourceControlPullRequestCommentsResult = {
  success: true;
  provider: SourceControlProvider;
  repositoryFullName: string;
  number: number;
  threads: SourceControlPullRequestCommentThread[];
  issueComments: SourceControlPullRequestComment[];
  warnings: string[];
};

type SourceControlPullRequestReadResult =
  | SourceControlPullRequestDetailsResult
  | SourceControlPullRequestCommentsResult;

/**
 * Mirrors SourceControlMutationError in source-control-pull-requests.ts so
 * read callers can map client-addressable failures to HTTP statuses the same
 * way the mutation surface does.
 */
export class SourceControlReadError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'SourceControlReadError';
  }
}

const gitLabMergeRequestDetailsSchema = z
  .object({
    iid: z.number().int(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    web_url: z.string().url().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    source_branch: z.string(),
    target_branch: z.string(),
    has_conflicts: z.boolean().optional(),
    merge_status: z.string().nullable().optional(),
    detailed_merge_status: z.string().nullable().optional(),
    source_project_id: z.number().nullable().optional(),
    target_project_id: z.number().nullable().optional(),
    sha: z.string().nullable().optional(),
    diff_refs: z
      .object({
        base_sha: z.string().nullable().optional(),
        head_sha: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    author: z.object({ username: z.string().optional() }).nullable().optional(),
  })
  .passthrough();

const gitLabDiscussionNoteSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    body: z.string().optional(),
    system: z.boolean().optional(),
    type: z.string().nullable().optional(),
    resolvable: z.boolean().optional(),
    resolved: z.boolean().optional(),
    created_at: z.string().optional(),
    author: z.object({ username: z.string().optional() }).nullable().optional(),
    position: z
      .object({
        new_path: z.string().nullable().optional(),
        new_line: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
const gitLabDiscussionListSchema = z.array(
  z
    .object({
      id: z.string(),
      notes: z.array(gitLabDiscussionNoteSchema).optional(),
    })
    .passthrough(),
);

const giteaPullRequestDetailsSchema = z
  .object({
    number: z.number().int().optional(),
    index: z.number().int().optional(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    state: z.string().optional(),
    merged: z.boolean().optional(),
    mergeable: z.boolean().optional(),
    draft: z.boolean().optional(),
    html_url: z.string().url().optional(),
    user: z.object({ login: z.string().optional() }).nullable().optional(),
    head: z
      .object({
        ref: z.string().optional(),
        sha: z.string().nullable().optional(),
        repo: z
          .object({ full_name: z.string().optional() })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    base: z
      .object({
        ref: z.string().optional(),
        sha: z.string().nullable().optional(),
        repo: z
          .object({ full_name: z.string().optional() })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const giteaCommentSchema = z
  .object({
    id: z.number().int(),
    body: z.string().nullable().optional(),
    created_at: z.string().optional(),
    html_url: z.string().optional(),
    path: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
    user: z.object({ login: z.string().optional() }).nullable().optional(),
  })
  .passthrough();
const giteaCommentListSchema = z.array(giteaCommentSchema);
const giteaReviewListSchema = z.array(
  z.object({ id: z.number().int() }).passthrough(),
);

const adoPullRequestDetailsSchema = z
  .object({
    pullRequestId: z.number().int(),
    title: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    isDraft: z.boolean().optional(),
    mergeStatus: z.string().optional(),
    forkSource: z
      .object({
        repository: z
          .object({ name: z.string().optional() })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    sourceRefName: z.string().optional(),
    targetRefName: z.string().optional(),
    lastMergeSourceCommit: z
      .object({ commitId: z.string().optional() })
      .nullable()
      .optional(),
    lastMergeTargetCommit: z
      .object({ commitId: z.string().optional() })
      .nullable()
      .optional(),
    createdBy: z
      .object({
        displayName: z.string().optional(),
        uniqueName: z.string().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const adoCommentSchema = z
  .object({
    id: z.number().int().optional(),
    content: z.string().nullable().optional(),
    commentType: z.string().optional(),
    publishedDate: z.string().optional(),
    author: z
      .object({
        displayName: z.string().optional(),
        uniqueName: z.string().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
const adoThreadListSchema = z.object({
  value: z.array(
    z
      .object({
        id: z.number().int(),
        status: z.string().nullable().optional(),
        isDeleted: z.boolean().optional(),
        threadContext: z
          .object({
            filePath: z.string().nullable().optional(),
            rightFileStart: z
              .object({ line: z.number().optional() })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
        comments: z.array(adoCommentSchema).optional(),
      })
      .passthrough(),
  ),
});

const gitHubReviewThreadsQueryResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          reviewThreads: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                isResolved: z.boolean(),
                path: z.string().nullable().optional(),
                line: z.number().nullable().optional(),
                comments: z.object({
                  nodes: z.array(
                    z.object({
                      databaseId: z.number().nullable().optional(),
                      author: z
                        .object({ login: z.string() })
                        .nullable()
                        .optional(),
                      body: z.string(),
                      createdAt: z.string().nullable().optional(),
                      url: z.string().nullable().optional(),
                    }),
                  ),
                }),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export async function readSourceControlPullRequestForCloudJob({
  cloudJob,
  input,
  fetchImpl = fetch,
}: {
  cloudJob: Run;
  input: SourceControlPullRequestReadInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlPullRequestReadResult> {
  const payloadProvider = resolveSourceControlProviderFromPayload(
    getPayloadRecord(cloudJob.payload),
  );
  const provider = input.sourceControlProvider ?? payloadProvider;

  if (provider !== payloadProvider) {
    throw new Error(
      `Source control provider mismatch: task uses ${getSourceControlProviderLabel(
        payloadProvider,
      )}, but request specified ${getSourceControlProviderLabel(provider)}.`,
    );
  }

  await assertRepositoryInCloudJobScope(cloudJob, input.repositoryFullName);

  const repository = await resolveRepositoryRow({
    provider,
    repositoryFullName: input.repositoryFullName,
  });

  switch (provider) {
    case 'github':
      return input.action === 'get_pull_request'
        ? getGitHubPullRequestDetails({ input, repository, provider })
        : listGitHubPullRequestComments({ input, repository, provider });
    case 'gitlab':
      return input.action === 'get_pull_request'
        ? getGitLabMergeRequestDetails({
            input,
            repository,
            provider,
            fetchImpl,
          })
        : listGitLabMergeRequestComments({
            input,
            repository,
            provider,
            fetchImpl,
          });
    case 'gitea':
      return input.action === 'get_pull_request'
        ? getGiteaPullRequestDetails({ input, repository, provider, fetchImpl })
        : listGiteaPullRequestComments({
            input,
            repository,
            provider,
            fetchImpl,
          });
    case 'ado':
      return input.action === 'get_pull_request'
        ? getAdoPullRequestDetails({ input, repository, provider, fetchImpl })
        : listAdoPullRequestComments({
            input,
            repository,
            provider,
            fetchImpl,
          });
  }
}

async function getGitHubPullRequestDetails({
  input,
  repository,
  provider,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'github';
}): Promise<SourceControlPullRequestDetailsResult> {
  const { octokit, owner, repo } = await createGitHubReadClient(
    repository,
    provider,
  );

  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: input.prNumber,
  });

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: data.number,
    url: data.html_url,
    title: data.title,
    body: data.body ?? '',
    state: data.merged_at
      ? 'merged'
      : data.state === 'closed'
        ? 'closed'
        : 'open',
    draft: Boolean(data.draft),
    sourceBranch: data.head.ref,
    targetBranch: data.base.ref,
    headSha: data.head.sha ?? null,
    baseSha: data.base.sha ?? null,
    author: data.user?.login ?? null,
    mergeable: data.mergeable ?? null,
    mergeStateDescription: data.mergeable_state ?? null,
    isCrossRepository:
      data.head?.repo && data.base?.repo
        ? data.head.repo.full_name !== data.base.repo.full_name
        : null,
    headRepositoryFullName: data.head?.repo?.full_name ?? null,
    warnings: [],
  };
}

async function listGitHubPullRequestComments({
  input,
  repository,
  provider,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'github';
}): Promise<SourceControlPullRequestCommentsResult> {
  const { octokit, owner, repo } = await createGitHubReadClient(
    repository,
    provider,
  );
  const warnings: string[] = [];

  const [reviewComments, restIssueComments] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: input.prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: input.prNumber,
      per_page: 100,
    }),
  ]);

  const issueComments: SourceControlPullRequestComment[] =
    restIssueComments.map((comment) => ({
      id: String(comment.id),
      author: comment.user?.login ?? null,
      body: comment.body ?? '',
      createdAt: comment.created_at ?? null,
      url: comment.html_url ?? null,
    }));

  let threads: SourceControlPullRequestCommentThread[];

  try {
    threads = await fetchGitHubReviewThreadsViaGraphql({
      octokit,
      owner,
      repo,
      prNumber: input.prNumber,
    });
  } catch (error) {
    warnings.push(
      `GitHub review thread resolution could not be fetched (${
        error instanceof Error ? error.message : String(error)
      }); threads were grouped from review comments without resolution state.`,
    );
    threads = groupGitHubReviewCommentsIntoThreads(reviewComments);
  }

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: input.prNumber,
    threads,
    issueComments,
    warnings,
  };
}

async function createGitHubReadClient(
  repository: RepositoryRow,
  provider: 'github',
): Promise<{
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
}> {
  if (!repository.installationId) {
    throw new Error(
      `GitHub repository ${repository.fullName} is missing an installation id.`,
    );
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, provider);
  const token = await createGitHubToken({
    type: 'installationId',
    installationId: repository.installationId,
  });

  return { octokit: getOctokit(token), owner, repo };
}

async function fetchGitHubReviewThreadsViaGraphql({
  octokit,
  owner,
  repo,
  prNumber,
}: {
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<SourceControlPullRequestCommentThread[]> {
  const response = await octokit.graphql(
    `query PullRequestReviewThreads($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              comments(first: 50) {
                nodes {
                  databaseId
                  author { login }
                  body
                  createdAt
                  url
                }
              }
            }
          }
        }
      }
    }`,
    { owner, name: repo, number: prNumber },
  );

  const parsed = gitHubReviewThreadsQueryResponseSchema.parse(response);
  const pullRequest = parsed.repository?.pullRequest;

  if (!pullRequest) {
    throw new Error('GraphQL response did not include the pull request.');
  }

  return pullRequest.reviewThreads.nodes.map((thread) => ({
    id: thread.id,
    resolved: thread.isResolved,
    path: thread.path ?? null,
    line: thread.line ?? null,
    comments: thread.comments.nodes.map((comment) => ({
      id: comment.databaseId != null ? String(comment.databaseId) : '',
      author: comment.author?.login ?? null,
      body: comment.body,
      createdAt: comment.createdAt ?? null,
      url: comment.url ?? null,
    })),
  }));
}

function groupGitHubReviewCommentsIntoThreads(
  reviewComments: Array<{
    id: number;
    in_reply_to_id?: number;
    path?: string | null;
    line?: number | null;
    original_line?: number | null;
    body?: string;
    created_at?: string;
    html_url?: string;
    user?: { login?: string } | null;
  }>,
): SourceControlPullRequestCommentThread[] {
  const threadsByRootId = new Map<
    number,
    SourceControlPullRequestCommentThread
  >();

  for (const comment of reviewComments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    let thread = threadsByRootId.get(rootId);

    if (!thread) {
      thread = {
        id: String(rootId),
        resolved: null,
        path: comment.path ?? null,
        line: comment.line ?? comment.original_line ?? null,
        comments: [],
      };
      threadsByRootId.set(rootId, thread);
    }

    thread.comments.push({
      id: String(comment.id),
      author: comment.user?.login ?? null,
      body: comment.body ?? '',
      createdAt: comment.created_at ?? null,
      url: comment.html_url ?? null,
    });
  }

  return [...threadsByRootId.values()];
}

async function getGitLabMergeRequestDetails({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'gitlab';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestDetailsResult> {
  const { projectId, token, apiBaseUrl } =
    await resolveGitLabReadContext(repository);

  const mergeRequest = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${input.prNumber}`,
      {},
    ),
    tokenHeader: { name: 'PRIVATE-TOKEN', value: token },
    schema: gitLabMergeRequestDetailsSchema,
  });

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: mergeRequest.iid,
    url:
      mergeRequest.web_url ??
      buildPullRequestUrl({
        provider,
        host: new URL(apiBaseUrl).host,
        repositoryFullName: repository.fullName,
        number: mergeRequest.iid,
      }),
    title: mergeRequest.title,
    body: mergeRequest.description ?? '',
    state:
      mergeRequest.state === 'merged'
        ? 'merged'
        : mergeRequest.state === 'closed'
          ? 'closed'
          : 'open',
    draft: isGitLabDraft(mergeRequest),
    sourceBranch: mergeRequest.source_branch,
    targetBranch: mergeRequest.target_branch,
    headSha: mergeRequest.diff_refs?.head_sha ?? mergeRequest.sha ?? null,
    baseSha: mergeRequest.diff_refs?.base_sha ?? null,
    author: mergeRequest.author?.username ?? null,
    mergeable:
      typeof mergeRequest.has_conflicts === 'boolean'
        ? !mergeRequest.has_conflicts
        : null,
    mergeStateDescription:
      mergeRequest.detailed_merge_status ?? mergeRequest.merge_status ?? null,
    isCrossRepository:
      typeof mergeRequest.source_project_id === 'number' &&
      typeof mergeRequest.target_project_id === 'number'
        ? mergeRequest.source_project_id !== mergeRequest.target_project_id
        : null,
    // The GitLab MR payload does not carry the source project path; left null
    // rather than fetching the source project from another endpoint.
    headRepositoryFullName: null,
    warnings: [],
  };
}

async function listGitLabMergeRequestComments({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'gitlab';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestCommentsResult> {
  const { projectId, token, apiBaseUrl } =
    await resolveGitLabReadContext(repository);

  const discussions = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${input.prNumber}/discussions`,
      { per_page: 100 },
    ),
    tokenHeader: { name: 'PRIVATE-TOKEN', value: token },
    schema: gitLabDiscussionListSchema,
  });

  const threads: SourceControlPullRequestCommentThread[] = [];
  const issueComments: SourceControlPullRequestComment[] = [];

  for (const discussion of discussions) {
    const notes = (discussion.notes ?? []).filter((note) => !note.system);

    if (notes.length === 0) {
      continue;
    }

    const firstNote = notes[0]!;
    const comments = notes.map((note) => ({
      id: String(note.id),
      author: note.author?.username ?? null,
      body: note.body ?? '',
      createdAt: note.created_at ?? null,
      url: null,
    }));

    const isDiffNote = firstNote.type === 'DiffNote';

    if (!isDiffNote && notes.length === 1 && !firstNote.resolvable) {
      issueComments.push(...comments);
      continue;
    }

    const resolvableNotes = notes.filter((note) => note.resolvable);

    threads.push({
      id: discussion.id,
      resolved:
        resolvableNotes.length > 0
          ? resolvableNotes.every((note) => Boolean(note.resolved))
          : null,
      path: isDiffNote ? (firstNote.position?.new_path ?? null) : null,
      line: isDiffNote ? (firstNote.position?.new_line ?? null) : null,
      comments,
    });
  }

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: input.prNumber,
    threads,
    issueComments,
    warnings: [],
  };
}

async function resolveGitLabReadContext(
  repository: RepositoryRow,
): Promise<{ projectId: string; token: string; apiBaseUrl: string }> {
  if (!repository.externalRepoId) {
    throw new Error(
      `GitLab repository ${repository.fullName} is missing an external project id.`,
    );
  }

  const token = await resolveGitLabToken();
  if (!token) {
    throw new Error('GITLAB_TOKEN is required to read GitLab merge requests.');
  }

  const apiBaseUrl = buildGitLabApiBaseUrl(await resolveGitLabBaseUrl());

  return { projectId: repository.externalRepoId, token, apiBaseUrl };
}

async function getGiteaPullRequestDetails({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'gitea';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestDetailsResult> {
  const { apiBaseUrl, baseUrl, owner, repo, token } =
    await resolveGiteaReadContext(repository, provider);

  const pullRequest = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}`,
      {},
    ),
    tokenHeader: { name: 'Authorization', value: `token ${token}` },
    schema: giteaPullRequestDetailsSchema,
  });

  const number = pullRequest.number ?? pullRequest.index ?? input.prNumber;
  const title = pullRequest.title ?? '';
  const host = new URL(baseUrl).host;

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number,
    url:
      pullRequest.html_url ??
      buildPullRequestUrl({
        provider,
        host,
        repositoryFullName: repository.fullName,
        number,
      }),
    title,
    body: pullRequest.body ?? '',
    state: pullRequest.merged
      ? 'merged'
      : pullRequest.state === 'closed'
        ? 'closed'
        : 'open',
    draft: Boolean(pullRequest.draft) || isDraftTitle(title),
    sourceBranch: pullRequest.head?.ref ?? '',
    targetBranch: pullRequest.base?.ref ?? '',
    headSha: pullRequest.head?.sha ?? null,
    baseSha: pullRequest.base?.sha ?? null,
    author: pullRequest.user?.login ?? null,
    mergeable: pullRequest.mergeable ?? null,
    mergeStateDescription: null,
    isCrossRepository:
      pullRequest.head?.repo?.full_name && pullRequest.base?.repo?.full_name
        ? pullRequest.head.repo.full_name !== pullRequest.base.repo.full_name
        : null,
    headRepositoryFullName: pullRequest.head?.repo?.full_name ?? null,
    warnings: [],
  };
}

async function listGiteaPullRequestComments({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'gitea';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestCommentsResult> {
  const { apiBaseUrl, owner, repo, token } = await resolveGiteaReadContext(
    repository,
    provider,
  );
  const tokenHeader = { name: 'Authorization', value: `token ${token}` };
  const warnings: string[] = [];

  const issueCommentRows = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${input.prNumber}/comments`,
      {},
    ),
    tokenHeader,
    schema: giteaCommentListSchema,
  });

  const issueComments = issueCommentRows.map(mapGiteaComment);

  const reviews = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}/reviews`,
      {},
    ),
    tokenHeader,
    schema: giteaReviewListSchema,
  });

  const threads: SourceControlPullRequestCommentThread[] = [];

  for (const review of reviews) {
    const reviewComments = await requestJson({
      fetchImpl,
      url: buildApiUrl(
        apiBaseUrl,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}/reviews/${review.id}/comments`,
        {},
      ),
      tokenHeader,
      schema: giteaCommentListSchema,
    });

    if (reviewComments.length === 0) {
      continue;
    }

    threads.push({
      id: String(review.id),
      resolved: null,
      path: reviewComments[0]?.path ?? null,
      line: reviewComments[0]?.line ?? null,
      comments: reviewComments.map(mapGiteaComment),
    });
  }

  if (threads.length > 0) {
    warnings.push(
      'Gitea does not expose review thread resolution; resolved is reported as null.',
    );
  }

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: input.prNumber,
    threads,
    issueComments,
    warnings,
  };
}

function mapGiteaComment(
  comment: z.infer<typeof giteaCommentSchema>,
): SourceControlPullRequestComment {
  return {
    id: String(comment.id),
    author: comment.user?.login ?? null,
    body: comment.body ?? '',
    createdAt: comment.created_at ?? null,
    url: comment.html_url ?? null,
  };
}

async function resolveGiteaReadContext(
  repository: RepositoryRow,
  provider: 'gitea',
): Promise<{
  apiBaseUrl: string;
  baseUrl: string;
  owner: string;
  repo: string;
  token: string;
}> {
  const token = await resolveGiteaToken();
  if (!token) {
    throw new Error('GITEA_TOKEN is required to read Gitea pull requests.');
  }

  const baseUrl = await resolveGiteaBaseUrl();
  if (!baseUrl) {
    throw new Error('GITEA_BASE_URL is required to read Gitea pull requests.');
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, provider);

  return {
    apiBaseUrl: buildGiteaApiBaseUrl(baseUrl),
    baseUrl,
    owner,
    repo,
    token,
  };
}

async function getAdoPullRequestDetails({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'ado';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestDetailsResult> {
  const { baseUrl, organizationApiBaseUrl, repositoryPullRequestsPath, token } =
    await resolveAdoReadContext(repository);

  const pullRequest = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      organizationApiBaseUrl,
      `${repositoryPullRequestsPath}/${input.prNumber}`,
      { 'api-version': ADO_API_VERSION },
    ),
    tokenHeader: {
      name: 'Authorization',
      value: buildAdoBasicAuthHeader(token),
    },
    schema: adoPullRequestDetailsSchema,
  });

  const host = new URL(baseUrl).host;

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: pullRequest.pullRequestId,
    url: buildPullRequestUrl({
      provider,
      host,
      repositoryFullName: repository.fullName,
      number: pullRequest.pullRequestId,
    }),
    title: pullRequest.title,
    body: pullRequest.description ?? '',
    state:
      pullRequest.status === 'completed'
        ? 'merged'
        : pullRequest.status === 'abandoned'
          ? 'closed'
          : 'open',
    draft: Boolean(pullRequest.isDraft),
    sourceBranch: stripAdoBranchRef(pullRequest.sourceRefName ?? ''),
    targetBranch: stripAdoBranchRef(pullRequest.targetRefName ?? ''),
    headSha: pullRequest.lastMergeSourceCommit?.commitId ?? null,
    baseSha: pullRequest.lastMergeTargetCommit?.commitId ?? null,
    author:
      pullRequest.createdBy?.displayName ??
      pullRequest.createdBy?.uniqueName ??
      null,
    mergeable:
      pullRequest.mergeStatus === 'succeeded'
        ? true
        : pullRequest.mergeStatus === 'conflicts'
          ? false
          : null,
    mergeStateDescription: pullRequest.mergeStatus ?? null,
    // ADO exposes forkSource only on fork PRs, so its absence means same-repo.
    isCrossRepository: pullRequest.forkSource ? true : false,
    headRepositoryFullName: pullRequest.forkSource?.repository?.name ?? null,
    warnings: [],
  };
}

async function listAdoPullRequestComments({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestReadInput;
  repository: RepositoryRow;
  provider: 'ado';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestCommentsResult> {
  const { organizationApiBaseUrl, repositoryPullRequestsPath, token } =
    await resolveAdoReadContext(repository);

  const threadList = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      organizationApiBaseUrl,
      `${repositoryPullRequestsPath}/${input.prNumber}/threads`,
      { 'api-version': ADO_API_VERSION },
    ),
    tokenHeader: {
      name: 'Authorization',
      value: buildAdoBasicAuthHeader(token),
    },
    schema: adoThreadListSchema,
  });

  const threads: SourceControlPullRequestCommentThread[] = [];
  const issueComments: SourceControlPullRequestComment[] = [];

  for (const thread of threadList.value) {
    if (thread.isDeleted) {
      continue;
    }

    const comments = (thread.comments ?? [])
      .filter((comment) => comment.commentType !== 'system')
      .map((comment) => ({
        id: comment.id != null ? String(comment.id) : '',
        author:
          comment.author?.displayName ?? comment.author?.uniqueName ?? null,
        body: comment.content ?? '',
        createdAt: comment.publishedDate ?? null,
        url: null,
      }));

    if (comments.length === 0) {
      continue;
    }

    if (!thread.threadContext && comments.length === 1) {
      issueComments.push(...comments);
      continue;
    }

    threads.push({
      id: String(thread.id),
      resolved: mapAdoThreadResolution(thread.status ?? null),
      path: thread.threadContext?.filePath ?? null,
      line: thread.threadContext?.rightFileStart?.line ?? null,
      comments,
    });
  }

  return {
    success: true,
    provider,
    repositoryFullName: repository.fullName,
    number: input.prNumber,
    threads,
    issueComments,
    warnings: [],
  };
}

function mapAdoThreadResolution(status: string | null): boolean | null {
  switch (status) {
    case 'active':
    case 'pending':
      return false;
    case 'fixed':
    case 'closed':
    case 'wontFix':
    case 'byDesign':
      return true;
    default:
      return null;
  }
}

async function resolveAdoReadContext(repository: RepositoryRow): Promise<{
  baseUrl: string;
  organizationApiBaseUrl: string;
  repositoryPullRequestsPath: string;
  token: string;
}> {
  if (!repository.externalRepoId) {
    throw new Error(
      `Azure DevOps repository ${repository.fullName} is missing an external repository id.`,
    );
  }

  const token = await resolveAdoToken();
  if (!token) {
    throw new Error(
      'ADO_TOKEN is required to read Azure DevOps pull requests.',
    );
  }

  const { organization, project } = parseAdoRepositoryFullName(
    repository.fullName,
  );
  const baseUrl = await resolveAdoBaseUrl();
  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl,
    organization,
  });
  const repositoryPullRequestsPath = `/${encodeURIComponent(
    project,
  )}/_apis/git/repositories/${encodeURIComponent(
    repository.externalRepoId,
  )}/pullrequests`;

  return { baseUrl, organizationApiBaseUrl, repositoryPullRequestsPath, token };
}

// Mirrors requestJson in source-control-pull-requests.ts (reads are GET-only).
async function requestJson<T>({
  fetchImpl,
  url,
  tokenHeader,
  schema,
}: {
  fetchImpl: FetchImpl;
  url: string;
  tokenHeader: { name: string; value: string };
  schema: z.ZodType<T>;
}): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      [tokenHeader.name]: tokenHeader.value,
    },
  });

  if (response.status !== 200) {
    throw new Error(
      `Source control API request failed: ${response.status} ${
        response.statusText
      }${await formatResponseBody(response)}`,
    );
  }

  return schema.parse(await response.json());
}

function stripAdoBranchRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
