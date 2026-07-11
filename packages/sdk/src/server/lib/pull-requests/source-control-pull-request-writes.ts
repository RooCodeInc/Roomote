import { createGitHubToken } from '@roomote/auth';
import {
  buildAdoOrganizationApiBaseUrl,
  resolveAdoBaseUrl,
  resolveAdoToken,
} from '@roomote/ado';
import {
  buildBitbucketApiBaseUrl,
  resolveBitbucketBaseUrl,
  resolveBitbucketToken,
  resolveBitbucketUsername,
} from '@roomote/bitbucket';
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
import { type TaskRun } from '@roomote/db/server';
import {
  getSourceControlProviderLabel,
  resolveSourceControlProviderFromPayload,
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
  assertRepositoryInTaskRunScope,
  buildAdoBasicAuthHeader,
  buildApiUrl,
  formatResponseBody,
  getPayloadRecord,
  parseAdoRepositoryFullName,
  resolveRepositoryRow,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';

const ADO_API_VERSION = '7.1';

/**
 * Optional id fields from LLM/tool clients often arrive as `""` or whitespace
 * when the model "omits" them. Coerce blank values to undefined so they do not
 * fail min-length validation or get mistreated as present (e.g. GitHub update
 * routes review-thread vs top-level issue comments based on threadId).
 */
const optionalTrimmedNonEmptyStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(1).optional());

export const sourceControlPullRequestWriteInputSchema = z.object({
  action: z.enum([
    'reply_to_pull_request_comment',
    'create_pull_request_comment',
    'update_pull_request_comment',
    'resolve_pull_request_thread',
    'submit_pull_request_review',
  ]),
  repositoryFullName: z.string().trim().min(1),
  prNumber: z.number().int().positive(),
  /**
   * Required for reply/resolve actions (validated in code, not in the
   * schema). Thread ids match what the read surface returns per provider:
   * GitHub review thread GraphQL node ids, GitLab discussion ids, ADO
   * String(thread.id), Gitea String(review.id).
   *
   * For update_pull_request_comment on GitHub: omit (or leave blank) for
   * top-level issue comments; pass the review thread id only for
   * review-thread comments.
   */
  threadId: optionalTrimmedNonEmptyStringSchema,
  /**
   * Required for update_pull_request_comment: the comment id from
   * list_pull_request_comments or a prior write result.
   */
  commentId: optionalTrimmedNonEmptyStringSchema,
  /** Required for reply, create_comment, and update_comment; optional for review. */
  body: z.string().optional(),
  /** Required for resolve_pull_request_thread: true resolves, false reopens. */
  resolved: z.boolean().optional(),
  /** Required for submit_pull_request_review. */
  reviewEvent: z.enum(['approve', 'request_changes', 'comment']).optional(),
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type SourceControlPullRequestWriteInput = z.infer<
  typeof sourceControlPullRequestWriteInputSchema
>;

export type SourceControlPullRequestWriteResult = {
  success: true;
  action: SourceControlPullRequestWriteInput['action'];
  provider: SourceControlProvider;
  repositoryFullName: string;
  number: number;
  threadId: string | null;
  commentId: string | null;
  url: string | null;
  /**
   * False when the provider cannot perform the requested operation (a
   * capability gap, reported through warnings), never for real failures —
   * those throw.
   */
  applied: boolean;
  warnings: string[];
};

/**
 * Mirrors SourceControlReadError in source-control-pull-request-reads.ts so
 * write callers can map client-addressable failures to HTTP statuses the same
 * way the read and mutation surfaces do.
 */
export class SourceControlWriteError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'SourceControlWriteError';
  }
}

const GITHUB_REVIEW_EVENTS = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
} as const;

const GITEA_REVIEW_EVENTS = {
  approve: 'APPROVED',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
} as const;

const ADO_REVIEW_VOTES = {
  approve: 10,
  request_changes: -5,
} as const;

const gitHubReplyMutationResponseSchema = z.object({
  addPullRequestReviewThreadReply: z
    .object({
      comment: z
        .object({
          databaseId: z.number().nullable().optional(),
          url: z.string().nullable().optional(),
        })
        .nullable(),
    })
    .nullable(),
});

const gitHubResolvedThreadSchema = z
  .object({
    thread: z.object({ id: z.string(), isResolved: z.boolean() }).nullable(),
  })
  .nullable();
const gitHubResolveMutationResponseSchema = z.object({
  resolveReviewThread: gitHubResolvedThreadSchema.optional(),
  unresolveReviewThread: gitHubResolvedThreadSchema.optional(),
});

const gitLabNoteSchema = z
  .object({ id: z.union([z.number(), z.string()]) })
  .passthrough();

const giteaCreatedCommentSchema = z
  .object({
    id: z.number().int(),
    html_url: z.string().optional(),
  })
  .passthrough();

const giteaCreatedReviewSchema = z
  .object({
    id: z.number().int(),
    html_url: z.string().optional(),
  })
  .passthrough();

const bitbucketCreatedCommentSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    links: z
      .object({
        html: z.object({ href: z.string().optional() }).optional(),
      })
      .optional(),
  })
  .passthrough();

const adoCreatedCommentSchema = z
  .object({ id: z.number().int().optional() })
  .passthrough();

const adoThreadSchema = z
  .object({
    id: z.number().int(),
    status: z.string().nullable().optional(),
    comments: z.array(adoCreatedCommentSchema).optional(),
  })
  .passthrough();

const adoConnectionDataSchema = z
  .object({
    authenticatedUser: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

const adoReviewerVoteSchema = z
  .object({ vote: z.number().optional() })
  .passthrough();

export async function writeSourceControlPullRequestForTaskRun({
  taskRun,
  input: rawInput,
  fetchImpl = fetch,
}: {
  taskRun: TaskRun;
  input: SourceControlPullRequestWriteInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlPullRequestWriteResult> {
  // Defense in depth: blank/whitespace optional ids must never look "present"
  // even if a caller skips sourceControlPullRequestWriteInputSchema.
  const input = normalizeOptionalWriteIds(rawInput);
  assertWriteInputFields(input);

  const payloadProvider = resolveSourceControlProviderFromPayload(
    getPayloadRecord(taskRun.payload),
  );
  const provider = input.sourceControlProvider ?? payloadProvider;

  if (provider !== payloadProvider) {
    throw new Error(
      `Source control provider mismatch: task uses ${getSourceControlProviderLabel(
        payloadProvider,
      )}, but request specified ${getSourceControlProviderLabel(provider)}.`,
    );
  }

  await assertRepositoryInTaskRunScope(taskRun, input.repositoryFullName);

  const repository = await resolveRepositoryRow({
    provider,
    repositoryFullName: input.repositoryFullName,
  });

  switch (provider) {
    case 'github':
      return writeGitHubPullRequest({ input, repository, provider });
    case 'gitlab':
      return writeGitLabMergeRequest({
        input,
        repository,
        provider,
        fetchImpl,
      });
    case 'gitea':
      return writeGiteaPullRequest({ input, repository, provider, fetchImpl });
    case 'bitbucket':
      return writeBitbucketPullRequest({
        input,
        repository,
        provider,
        fetchImpl,
      });
    case 'ado':
      return writeAdoPullRequest({ input, repository, provider, fetchImpl });
  }
}

function normalizeOptionalWriteIds(
  input: SourceControlPullRequestWriteInput,
): SourceControlPullRequestWriteInput {
  return {
    ...input,
    threadId: blankToUndefined(input.threadId),
    commentId: blankToUndefined(input.commentId),
  };
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function assertWriteInputFields(
  input: SourceControlPullRequestWriteInput,
): void {
  switch (input.action) {
    case 'reply_to_pull_request_comment':
      requireThreadId(input);
      requireBody(input);
      break;
    case 'create_pull_request_comment':
      requireBody(input);
      break;
    case 'update_pull_request_comment':
      requireCommentId(input);
      requireBody(input);
      break;
    case 'resolve_pull_request_thread':
      requireThreadId(input);
      requireResolved(input);
      break;
    case 'submit_pull_request_review':
      requireReviewEvent(input);
      break;
  }
}

function requireThreadId(input: SourceControlPullRequestWriteInput): string {
  if (!input.threadId) {
    throw new SourceControlWriteError(
      400,
      `threadId is required for ${input.action}.`,
    );
  }

  return input.threadId;
}

function requireCommentId(input: SourceControlPullRequestWriteInput): string {
  if (!input.commentId) {
    throw new SourceControlWriteError(
      400,
      `commentId is required for ${input.action}.`,
    );
  }

  return input.commentId;
}

function requireBody(input: SourceControlPullRequestWriteInput): string {
  if (!input.body) {
    throw new SourceControlWriteError(
      400,
      `body is required for ${input.action}.`,
    );
  }

  return input.body;
}

function requireResolved(input: SourceControlPullRequestWriteInput): boolean {
  if (input.resolved === undefined) {
    throw new SourceControlWriteError(
      400,
      `resolved is required for ${input.action}: true resolves the thread, false reopens it.`,
    );
  }

  return input.resolved;
}

function requireReviewEvent(
  input: SourceControlPullRequestWriteInput,
): NonNullable<SourceControlPullRequestWriteInput['reviewEvent']> {
  if (!input.reviewEvent) {
    throw new SourceControlWriteError(
      400,
      `reviewEvent is required for ${input.action}.`,
    );
  }

  return input.reviewEvent;
}

function buildWriteResult({
  input,
  provider,
  repository,
  threadId = null,
  commentId = null,
  url = null,
  applied = true,
  warnings = [],
}: {
  input: SourceControlPullRequestWriteInput;
  provider: SourceControlProvider;
  repository: RepositoryRow;
  threadId?: string | null;
  commentId?: string | null;
  url?: string | null;
  applied?: boolean;
  warnings?: string[];
}): SourceControlPullRequestWriteResult {
  return {
    success: true,
    action: input.action,
    provider,
    repositoryFullName: repository.fullName,
    number: input.prNumber,
    threadId,
    commentId,
    url,
    applied,
    warnings,
  };
}

async function writeGitHubPullRequest({
  input,
  repository,
  provider,
}: {
  input: SourceControlPullRequestWriteInput;
  repository: RepositoryRow;
  provider: 'github';
}): Promise<SourceControlPullRequestWriteResult> {
  const { octokit, owner, repo } = await createGitHubWriteClient(
    repository,
    provider,
  );

  switch (input.action) {
    case 'reply_to_pull_request_comment': {
      const threadId = requireThreadId(input);
      const response = await octokit.graphql(
        `mutation AddPullRequestReviewThreadReply($threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(
            input: { pullRequestReviewThreadId: $threadId, body: $body }
          ) {
            comment { databaseId url }
          }
        }`,
        { threadId, body: requireBody(input) },
      );
      const comment =
        gitHubReplyMutationResponseSchema.parse(response)
          .addPullRequestReviewThreadReply?.comment;

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId,
        commentId:
          comment?.databaseId != null ? String(comment.databaseId) : null,
        url: comment?.url ?? null,
      });
    }
    case 'create_pull_request_comment': {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: input.prNumber,
        body: requireBody(input),
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        commentId: String(data.id),
        url: data.html_url ?? null,
      });
    }
    case 'update_pull_request_comment': {
      const commentId = requireCommentId(input);
      const body = requireBody(input);
      // A provided threadId marks the comment as a review-thread comment,
      // which lives on the pulls API; plain issue comments live on issues.
      const { data } = input.threadId
        ? await octokit.rest.pulls.updateReviewComment({
            owner,
            repo,
            comment_id: Number(commentId),
            body,
          })
        : await octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: Number(commentId),
            body,
          });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: input.threadId ?? null,
        commentId,
        url: data.html_url ?? null,
      });
    }
    case 'resolve_pull_request_thread': {
      const threadId = requireThreadId(input);
      const resolved = requireResolved(input);
      const response = await octokit.graphql(
        resolved
          ? `mutation ResolveReviewThread($threadId: ID!) {
              resolveReviewThread(input: { threadId: $threadId }) {
                thread { id isResolved }
              }
            }`
          : `mutation UnresolveReviewThread($threadId: ID!) {
              unresolveReviewThread(input: { threadId: $threadId }) {
                thread { id isResolved }
              }
            }`,
        { threadId },
      );
      const parsed = gitHubResolveMutationResponseSchema.parse(response);
      const thread = (
        resolved ? parsed.resolveReviewThread : parsed.unresolveReviewThread
      )?.thread;

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: thread?.id ?? threadId,
      });
    }
    case 'submit_pull_request_review': {
      const reviewEvent = requireReviewEvent(input);
      // GitHub requires a body string for COMMENT reviews; approvals and
      // change requests may omit it entirely.
      const body = reviewEvent === 'comment' ? (input.body ?? '') : input.body;
      const { data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: input.prNumber,
        event: GITHUB_REVIEW_EVENTS[reviewEvent],
        ...(body !== undefined ? { body } : {}),
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        commentId: String(data.id),
        url: data.html_url ?? null,
      });
    }
  }
}

// Mirrors createGitHubReadClient in source-control-pull-request-reads.ts.
async function createGitHubWriteClient(
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

async function writeGitLabMergeRequest({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestWriteInput;
  repository: RepositoryRow;
  provider: 'gitlab';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestWriteResult> {
  const { projectId, token, apiBaseUrl } =
    await resolveGitLabWriteContext(repository);
  const tokenHeader = { name: 'PRIVATE-TOKEN', value: token };
  const mergeRequestPath = `/projects/${encodeURIComponent(projectId)}/merge_requests/${input.prNumber}`;

  switch (input.action) {
    case 'reply_to_pull_request_comment': {
      const threadId = requireThreadId(input);
      const note = await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          apiBaseUrl,
          `${mergeRequestPath}/discussions/${encodeURIComponent(threadId)}/notes`,
          {},
        ),
        tokenHeader,
        body: { body: requireBody(input) },
        schema: gitLabNoteSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId,
        commentId: String(note.id),
      });
    }
    case 'create_pull_request_comment': {
      const note = await createGitLabNote({
        fetchImpl,
        apiBaseUrl,
        tokenHeader,
        mergeRequestPath,
        body: requireBody(input),
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        commentId: String(note.id),
      });
    }
    case 'update_pull_request_comment': {
      // The notes endpoint updates both plain notes and discussion notes.
      const commentId = requireCommentId(input);
      const note = await requestJson({
        fetchImpl,
        method: 'PUT',
        url: buildApiUrl(
          apiBaseUrl,
          `${mergeRequestPath}/notes/${encodeURIComponent(commentId)}`,
          {},
        ),
        tokenHeader,
        body: { body: requireBody(input) },
        schema: gitLabNoteSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: input.threadId ?? null,
        commentId: String(note.id),
      });
    }
    case 'resolve_pull_request_thread': {
      const threadId = requireThreadId(input);
      const resolved = requireResolved(input);
      const response = await performRequest({
        fetchImpl,
        method: 'PUT',
        url: buildApiUrl(
          apiBaseUrl,
          `${mergeRequestPath}/discussions/${encodeURIComponent(threadId)}`,
          {},
        ),
        tokenHeader,
        body: { resolved },
      });

      if ([200, 201].includes(response.status)) {
        return buildWriteResult({ input, provider, repository, threadId });
      }

      // GitLab answers 400 when the discussion is not resolvable (for
      // example a plain note discussion); report that as a capability gap
      // instead of failing the write.
      if (response.status === 400) {
        return buildWriteResult({
          input,
          provider,
          repository,
          threadId,
          applied: false,
          warnings: [
            `GitLab could not ${
              resolved ? 'resolve' : 'unresolve'
            } discussion ${threadId}; the discussion may not be resolvable${await formatResponseBody(response)}`,
          ],
        });
      }

      throw new Error(await buildRequestFailureMessage(response));
    }
    case 'submit_pull_request_review':
      return submitGitLabReview({
        input,
        repository,
        provider,
        fetchImpl,
        tokenHeader,
        mergeRequestPath,
        apiBaseUrl,
      });
  }
}

async function submitGitLabReview({
  input,
  repository,
  provider,
  fetchImpl,
  tokenHeader,
  mergeRequestPath,
  apiBaseUrl,
}: {
  input: SourceControlPullRequestWriteInput;
  repository: RepositoryRow;
  provider: 'gitlab';
  fetchImpl: FetchImpl;
  tokenHeader: { name: string; value: string };
  mergeRequestPath: string;
  apiBaseUrl: string;
}): Promise<SourceControlPullRequestWriteResult> {
  const reviewEvent = requireReviewEvent(input);

  if (reviewEvent === 'comment') {
    if (!input.body) {
      throw new SourceControlWriteError(
        400,
        'body is required for the comment review event on GitLab.',
      );
    }

    const note = await createGitLabNote({
      fetchImpl,
      apiBaseUrl,
      tokenHeader,
      mergeRequestPath,
      body: input.body,
    });

    return buildWriteResult({
      input,
      provider,
      repository,
      commentId: String(note.id),
    });
  }

  if (reviewEvent === 'request_changes') {
    const warnings = ['GitLab has no request-changes review event.'];
    let commentId: string | null = null;

    if (input.body) {
      const note = await createGitLabNote({
        fetchImpl,
        apiBaseUrl,
        tokenHeader,
        mergeRequestPath,
        body: input.body,
      });
      commentId = String(note.id);
      warnings.push(
        'The review body was posted as a merge request note instead.',
      );
    }

    return buildWriteResult({
      input,
      provider,
      repository,
      commentId,
      applied: false,
      warnings,
    });
  }

  // approve
  const response = await performRequest({
    fetchImpl,
    method: 'POST',
    url: buildApiUrl(apiBaseUrl, `${mergeRequestPath}/approve`, {}),
    tokenHeader,
  });

  // GitLab rejects approvals with 401/403/405 when the token user is not
  // allowed to approve; report that as a capability gap instead of failing.
  const approveRejected = [401, 403, 405].includes(response.status);

  if (!approveRejected && ![200, 201].includes(response.status)) {
    throw new Error(await buildRequestFailureMessage(response));
  }

  const warnings: string[] = approveRejected
    ? [
        `GitLab rejected the approval (${response.status}); the token user may not be allowed to approve this merge request.`,
      ]
    : [];
  let commentId: string | null = null;

  if (input.body) {
    const note = await createGitLabNote({
      fetchImpl,
      apiBaseUrl,
      tokenHeader,
      mergeRequestPath,
      body: input.body,
    });
    commentId = String(note.id);

    if (approveRejected) {
      warnings.push('The review body was posted as a merge request note.');
    }
  }

  return buildWriteResult({
    input,
    provider,
    repository,
    commentId,
    applied: !approveRejected,
    warnings,
  });
}

async function createGitLabNote({
  fetchImpl,
  apiBaseUrl,
  tokenHeader,
  mergeRequestPath,
  body,
}: {
  fetchImpl: FetchImpl;
  apiBaseUrl: string;
  tokenHeader: { name: string; value: string };
  mergeRequestPath: string;
  body: string;
}): Promise<z.infer<typeof gitLabNoteSchema>> {
  return requestJson({
    fetchImpl,
    method: 'POST',
    url: buildApiUrl(apiBaseUrl, `${mergeRequestPath}/notes`, {}),
    tokenHeader,
    body: { body },
    schema: gitLabNoteSchema,
  });
}

// Mirrors resolveGitLabReadContext in source-control-pull-request-reads.ts.
async function resolveGitLabWriteContext(
  repository: RepositoryRow,
): Promise<{ projectId: string; token: string; apiBaseUrl: string }> {
  if (!repository.externalRepoId) {
    throw new Error(
      `GitLab repository ${repository.fullName} is missing an external project id.`,
    );
  }

  const token = await resolveGitLabToken();
  if (!token) {
    throw new Error('GITLAB_TOKEN is required to write GitLab merge requests.');
  }

  const apiBaseUrl = buildGitLabApiBaseUrl(await resolveGitLabBaseUrl());

  return { projectId: repository.externalRepoId, token, apiBaseUrl };
}

async function writeGiteaPullRequest({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestWriteInput;
  repository: RepositoryRow;
  provider: 'gitea';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestWriteResult> {
  const { apiBaseUrl, owner, repo, token } = await resolveGiteaWriteContext(
    repository,
    provider,
  );
  const tokenHeader = { name: 'Authorization', value: `token ${token}` };
  const issueCommentsUrl = buildApiUrl(
    apiBaseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${input.prNumber}/comments`,
    {},
  );

  switch (input.action) {
    case 'reply_to_pull_request_comment': {
      // Gitea has no API for replying inside a review thread; fall back to an
      // issue comment that references the thread.
      const threadId = requireThreadId(input);
      const comment = await requestJson({
        fetchImpl,
        method: 'POST',
        url: issueCommentsUrl,
        tokenHeader,
        body: {
          body: `> Re: review thread ${threadId}\n\n${requireBody(input)}`,
        },
        schema: giteaCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId,
        commentId: String(comment.id),
        url: comment.html_url ?? null,
        warnings: [
          'Gitea does not support threaded replies; posted as an issue comment.',
        ],
      });
    }
    case 'create_pull_request_comment': {
      const comment = await requestJson({
        fetchImpl,
        method: 'POST',
        url: issueCommentsUrl,
        tokenHeader,
        body: { body: requireBody(input) },
        schema: giteaCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        commentId: String(comment.id),
        url: comment.html_url ?? null,
      });
    }
    case 'update_pull_request_comment': {
      const commentId = requireCommentId(input);
      const comment = await requestJson({
        fetchImpl,
        method: 'PATCH',
        url: buildApiUrl(
          apiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${encodeURIComponent(commentId)}`,
          {},
        ),
        tokenHeader,
        body: { body: requireBody(input) },
        schema: giteaCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: input.threadId ?? null,
        commentId: String(comment.id),
        url: comment.html_url ?? null,
      });
    }
    case 'resolve_pull_request_thread': {
      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: requireThreadId(input),
        applied: false,
        warnings: ['Gitea does not expose review thread resolution.'],
      });
    }
    case 'submit_pull_request_review': {
      const reviewEvent = requireReviewEvent(input);
      const review = await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          apiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}/reviews`,
          {},
        ),
        tokenHeader,
        body: {
          event: GITEA_REVIEW_EVENTS[reviewEvent],
          body: input.body ?? '',
        },
        schema: giteaCreatedReviewSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        commentId: String(review.id),
        url: review.html_url ?? null,
      });
    }
  }
}

// Mirrors resolveGiteaReadContext in source-control-pull-request-reads.ts.
async function resolveGiteaWriteContext(
  repository: RepositoryRow,
  provider: 'gitea',
): Promise<{
  apiBaseUrl: string;
  owner: string;
  repo: string;
  token: string;
}> {
  const token = await resolveGiteaToken();
  if (!token) {
    throw new Error('GITEA_TOKEN is required to write Gitea pull requests.');
  }

  const baseUrl = await resolveGiteaBaseUrl();
  if (!baseUrl) {
    throw new Error('GITEA_BASE_URL is required to write Gitea pull requests.');
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, provider);

  return {
    apiBaseUrl: buildGiteaApiBaseUrl(baseUrl),
    owner,
    repo,
    token,
  };
}

async function writeBitbucketPullRequest({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestWriteInput;
  repository: RepositoryRow;
  provider: 'bitbucket';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestWriteResult> {
  const { apiBaseUrl, authHeader, workspace, repo } =
    await resolveBitbucketWriteContext(repository, provider);
  const tokenHeader = { name: 'Authorization', value: authHeader };
  const commentsUrl = buildApiUrl(
    apiBaseUrl,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/pullrequests/${input.prNumber}/comments`,
    {},
  );

  switch (input.action) {
    case 'reply_to_pull_request_comment': {
      const threadId = requireThreadId(input);
      const comment = await requestJson({
        fetchImpl,
        method: 'POST',
        url: commentsUrl,
        tokenHeader,
        body: {
          content: {
            raw: `> Re: review thread ${threadId}\n\n${requireBody(input)}`,
          },
          parent: { id: threadId },
        },
        schema: bitbucketCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId,
        commentId:
          comment.id === undefined || comment.id === null
            ? null
            : String(comment.id),
        url: comment.links?.html?.href ?? null,
      });
    }
    case 'create_pull_request_comment': {
      const comment = await requestJson({
        fetchImpl,
        method: 'POST',
        url: commentsUrl,
        tokenHeader,
        body: {
          content: { raw: requireBody(input) },
        },
        schema: bitbucketCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        commentId:
          comment.id === undefined || comment.id === null
            ? null
            : String(comment.id),
        url: comment.links?.html?.href ?? null,
      });
    }
    case 'update_pull_request_comment': {
      const commentId = requireCommentId(input);
      const comment = await requestJson({
        fetchImpl,
        method: 'PUT',
        url: buildApiUrl(
          apiBaseUrl,
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
            repo,
          )}/pullrequests/${input.prNumber}/comments/${encodeURIComponent(
            commentId,
          )}`,
          {},
        ),
        tokenHeader,
        body: {
          content: { raw: requireBody(input) },
        },
        schema: bitbucketCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: input.threadId ?? null,
        commentId:
          comment.id === undefined || comment.id === null
            ? String(commentId)
            : String(comment.id),
        url: comment.links?.html?.href ?? null,
      });
    }
    case 'resolve_pull_request_thread': {
      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: requireThreadId(input),
        applied: false,
        warnings: ['Bitbucket does not expose review thread resolution.'],
      });
    }
    case 'submit_pull_request_review': {
      const reviewEvent = requireReviewEvent(input);

      if (reviewEvent === 'request_changes') {
        return buildWriteResult({
          input,
          provider,
          repository,
          applied: false,
          warnings: [
            'Bitbucket does not support request_changes reviews through this API surface.',
          ],
        });
      }

      if (reviewEvent === 'comment') {
        if (!input.body?.trim()) {
          return buildWriteResult({
            input,
            provider,
            repository,
            applied: false,
            warnings: [
              'Bitbucket comment reviews require a body; nothing was posted.',
            ],
          });
        }

        const comment = await requestJson({
          fetchImpl,
          method: 'POST',
          url: commentsUrl,
          tokenHeader,
          body: {
            content: { raw: requireBody(input) },
          },
          schema: bitbucketCreatedCommentSchema,
        });

        return buildWriteResult({
          input,
          provider,
          repository,
          commentId:
            comment.id === undefined || comment.id === null
              ? null
              : String(comment.id),
          url: comment.links?.html?.href ?? null,
        });
      }

      const approveResponse = await performRequest({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          apiBaseUrl,
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
            repo,
          )}/pullrequests/${input.prNumber}/approve`,
          {},
        ),
        tokenHeader,
      });

      if (![200, 201].includes(approveResponse.status)) {
        throw new Error(await buildRequestFailureMessage(approveResponse));
      }

      if (input.body?.trim()) {
        const comment = await requestJson({
          fetchImpl,
          method: 'POST',
          url: commentsUrl,
          tokenHeader,
          body: {
            content: { raw: requireBody(input) },
          },
          schema: bitbucketCreatedCommentSchema,
        });

        return buildWriteResult({
          input,
          provider,
          repository,
          commentId:
            comment.id === undefined || comment.id === null
              ? null
              : String(comment.id),
          url: comment.links?.html?.href ?? null,
        });
      }

      return buildWriteResult({
        input,
        provider,
        repository,
      });
    }
  }
}

async function resolveBitbucketWriteContext(
  repository: RepositoryRow,
  provider: 'bitbucket',
): Promise<{
  apiBaseUrl: string;
  authHeader: string;
  workspace: string;
  repo: string;
}> {
  const token = await resolveBitbucketToken();
  if (!token) {
    throw new Error(
      'BITBUCKET_TOKEN is required to write Bitbucket pull requests.',
    );
  }

  const username = await resolveBitbucketUsername();
  if (!username) {
    throw new Error(
      'BITBUCKET_USERNAME is required to write Bitbucket pull requests.',
    );
  }

  const baseUrl = await resolveBitbucketBaseUrl();
  const [workspace, repo] = splitRepositoryFullName(
    repository.fullName,
    provider,
  );

  return {
    apiBaseUrl: buildBitbucketApiBaseUrl(baseUrl),
    authHeader: `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`,
    workspace,
    repo,
  };
}

async function writeAdoPullRequest({
  input,
  repository,
  provider,
  fetchImpl,
}: {
  input: SourceControlPullRequestWriteInput;
  repository: RepositoryRow;
  provider: 'ado';
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestWriteResult> {
  const { organizationApiBaseUrl, repositoryPullRequestsPath, token } =
    await resolveAdoWriteContext(repository);
  const tokenHeader = {
    name: 'Authorization',
    value: buildAdoBasicAuthHeader(token),
  };
  const threadsPath = `${repositoryPullRequestsPath}/${input.prNumber}/threads`;

  switch (input.action) {
    case 'reply_to_pull_request_comment': {
      const threadId = requireThreadId(input);
      const comment = await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          organizationApiBaseUrl,
          `${threadsPath}/${encodeURIComponent(threadId)}/comments`,
          { 'api-version': ADO_API_VERSION },
        ),
        tokenHeader,
        body: {
          content: requireBody(input),
          commentType: 'text',
          parentCommentId: 1,
        },
        schema: adoCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId,
        commentId: comment.id != null ? String(comment.id) : null,
      });
    }
    case 'create_pull_request_comment': {
      const thread = await createAdoCommentThread({
        fetchImpl,
        tokenHeader,
        organizationApiBaseUrl,
        threadsPath,
        content: requireBody(input),
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: String(thread.id),
        commentId: getFirstAdoCommentId(thread),
      });
    }
    case 'update_pull_request_comment': {
      const commentId = requireCommentId(input);

      // All ADO comments live inside a thread, so the thread id is part of
      // the comment resource path.
      if (!input.threadId) {
        throw new SourceControlWriteError(
          400,
          'threadId is required to update an Azure DevOps comment.',
        );
      }

      const comment = await requestJson({
        fetchImpl,
        method: 'PATCH',
        url: buildApiUrl(
          organizationApiBaseUrl,
          `${threadsPath}/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(commentId)}`,
          { 'api-version': ADO_API_VERSION },
        ),
        tokenHeader,
        body: { content: requireBody(input) },
        schema: adoCreatedCommentSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: input.threadId,
        commentId: comment.id != null ? String(comment.id) : commentId,
      });
    }
    case 'resolve_pull_request_thread': {
      const threadId = requireThreadId(input);
      const thread = await requestJson({
        fetchImpl,
        method: 'PATCH',
        url: buildApiUrl(
          organizationApiBaseUrl,
          `${threadsPath}/${encodeURIComponent(threadId)}`,
          { 'api-version': ADO_API_VERSION },
        ),
        tokenHeader,
        body: { status: requireResolved(input) ? 'fixed' : 'active' },
        schema: adoThreadSchema,
      });

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId: String(thread.id),
      });
    }
    case 'submit_pull_request_review': {
      const reviewEvent = requireReviewEvent(input);

      if (reviewEvent === 'comment') {
        if (!input.body) {
          throw new SourceControlWriteError(
            400,
            'body is required for the comment review event on Azure DevOps.',
          );
        }

        const thread = await createAdoCommentThread({
          fetchImpl,
          tokenHeader,
          organizationApiBaseUrl,
          threadsPath,
          content: input.body,
        });

        return buildWriteResult({
          input,
          provider,
          repository,
          threadId: String(thread.id),
          commentId: getFirstAdoCommentId(thread),
        });
      }

      // Reviewer votes are cast against the authenticated identity, which is
      // resolved through connectionData at the ORGANIZATION api root (not the
      // project-scoped repository api).
      const connectionData = await requestJson({
        fetchImpl,
        url: buildApiUrl(organizationApiBaseUrl, '/_apis/connectionData', {
          'api-version': ADO_API_VERSION,
        }),
        tokenHeader,
        schema: adoConnectionDataSchema,
      });

      await requestJson({
        fetchImpl,
        method: 'PUT',
        url: buildApiUrl(
          organizationApiBaseUrl,
          `${repositoryPullRequestsPath}/${input.prNumber}/reviewers/${encodeURIComponent(
            connectionData.authenticatedUser.id,
          )}`,
          { 'api-version': ADO_API_VERSION },
        ),
        tokenHeader,
        body: { vote: ADO_REVIEW_VOTES[reviewEvent] },
        schema: adoReviewerVoteSchema,
      });

      let threadId: string | null = null;
      let commentId: string | null = null;

      if (input.body) {
        const thread = await createAdoCommentThread({
          fetchImpl,
          tokenHeader,
          organizationApiBaseUrl,
          threadsPath,
          content: input.body,
        });
        threadId = String(thread.id);
        commentId = getFirstAdoCommentId(thread);
      }

      return buildWriteResult({
        input,
        provider,
        repository,
        threadId,
        commentId,
      });
    }
  }
}

async function createAdoCommentThread({
  fetchImpl,
  tokenHeader,
  organizationApiBaseUrl,
  threadsPath,
  content,
}: {
  fetchImpl: FetchImpl;
  tokenHeader: { name: string; value: string };
  organizationApiBaseUrl: string;
  threadsPath: string;
  content: string;
}): Promise<z.infer<typeof adoThreadSchema>> {
  return requestJson({
    fetchImpl,
    method: 'POST',
    url: buildApiUrl(organizationApiBaseUrl, threadsPath, {
      'api-version': ADO_API_VERSION,
    }),
    tokenHeader,
    body: {
      comments: [{ content, commentType: 'text' }],
      status: 'active',
    },
    schema: adoThreadSchema,
  });
}

function getFirstAdoCommentId(
  thread: z.infer<typeof adoThreadSchema>,
): string | null {
  const id = thread.comments?.[0]?.id;
  return id != null ? String(id) : null;
}

// Mirrors resolveAdoReadContext in source-control-pull-request-reads.ts.
async function resolveAdoWriteContext(repository: RepositoryRow): Promise<{
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
      'ADO_TOKEN is required to write Azure DevOps pull requests.',
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

  return { organizationApiBaseUrl, repositoryPullRequestsPath, token };
}

// Mirrors requestJson in source-control-pull-requests.ts, split so callers
// that must map specific statuses to capability warnings can inspect the raw
// response through performRequest.
async function requestJson<T>({
  fetchImpl,
  method = 'GET',
  url,
  tokenHeader,
  body,
  schema,
}: {
  fetchImpl: FetchImpl;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  tokenHeader: { name: string; value: string };
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<T> {
  const response = await performRequest({
    fetchImpl,
    method,
    url,
    tokenHeader,
    body,
  });

  if (![200, 201].includes(response.status)) {
    throw new Error(await buildRequestFailureMessage(response));
  }

  return schema.parse(await response.json());
}

async function performRequest({
  fetchImpl,
  method = 'GET',
  url,
  tokenHeader,
  body,
}: {
  fetchImpl: FetchImpl;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  tokenHeader: { name: string; value: string };
  body?: Record<string, unknown>;
}): Promise<Response> {
  return fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/json',
      [tokenHeader.name]: tokenHeader.value,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function buildRequestFailureMessage(response: Response): Promise<string> {
  return `Source control API request failed: ${response.status} ${
    response.statusText
  }${await formatResponseBody(response)}`;
}
