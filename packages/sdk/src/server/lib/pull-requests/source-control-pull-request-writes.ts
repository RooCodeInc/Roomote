import { createGitHubToken } from '@roomote/auth';
import { getOctokit } from '@roomote/github';
import { type TaskRun } from '@roomote/db/server';
import {
  getSourceControlProviderLabel,
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
  ADO_API_VERSION,
  adoCreatedCommentSchema,
  adoThreadSchema,
  createAdoCommentThread,
  getFirstAdoCommentId,
} from './source-control-pull-request-ado-writes';
import { SourceControlWriteError } from './source-control-pull-request-write-errors';
import {
  buildSourceControlRequestFailureMessage,
  performSourceControlRequest as performRequest,
  requestSourceControlJson as requestJson,
} from './source-control-pull-request-http';
import {
  resolveAdoProviderContext,
  resolveBitbucketProviderContext,
  resolveGiteaProviderContext,
  resolveGitLabProviderContext,
} from './source-control-pull-request-provider-context';
import {
  assertReviewCommentInputFields,
  createAdoPullRequestReviewComment,
  createBitbucketPullRequestReviewComment,
  createGiteaPullRequestReviewComment,
  createGitHubPullRequestReviewComment,
  createGitLabPullRequestReviewComment,
} from './source-control-pull-request-review-comments';
import {
  assertRepositoryInTaskRunScope,
  buildAdoBasicAuthHeader,
  buildApiUrl,
  buildGitLabTokenHeader,
  formatResponseBody,
  getPayloadRecord,
  resolveRepositoryRow,
  resolveSourceControlHostForRepositoryFromPayload,
  resolveSourceControlProviderForRepositoryFromPayload,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';

// `/_apis/connectionData` is a preview-only resource: Azure DevOps answers
// plain `7.1` (and `7.0`) with a 400 demanding the `-preview` suffix.
const ADO_CONNECTION_DATA_API_VERSION = '7.1-preview';

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
    'create_pull_request_review_comment',
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
  /**
   * Required for create_pull_request_review_comment: repository-relative
   * POSIX path of the file the comment anchors to.
   */
  path: optionalTrimmedNonEmptyStringSchema,
  /**
   * Required for create_pull_request_review_comment: 1-based line number in
   * the file version named by side.
   */
  line: z.number().int().positive().optional(),
  /**
   * Optional for create_pull_request_review_comment: RIGHT (default) anchors
   * on the new/head version of the file, LEFT on the old/base version
   * (deleted lines).
   */
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  /**
   * Optional multi-line range start for create_pull_request_review_comment.
   * GitHub and Azure DevOps honor the range; the other providers anchor to
   * `line` and report a warning.
   */
  startLine: z.number().int().positive().optional(),
  startSide: z.enum(['LEFT', 'RIGHT']).optional(),
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

export { SourceControlWriteError } from './source-control-pull-request-write-errors';

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

  const payloadRecord = getPayloadRecord(taskRun.payload);
  const payloadProvider = resolveSourceControlProviderForRepositoryFromPayload(
    payloadRecord,
    input.repositoryFullName,
  );
  const payloadHost = resolveSourceControlHostForRepositoryFromPayload(
    payloadRecord,
    input.repositoryFullName,
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
    host: payloadHost,
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
    path: blankToUndefined(input.path),
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
    case 'create_pull_request_review_comment':
      assertReviewCommentInputFields(input);
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
    case 'create_pull_request_review_comment': {
      return createGitHubPullRequestReviewComment({
        input,
        repository,
        octokit,
        owner,
        repo,
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
  const { projectId, token, apiBaseUrl } = await resolveGitLabProviderContext(
    repository,
    'write',
  );
  const tokenHeader = buildGitLabTokenHeader(token);
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
    case 'create_pull_request_review_comment': {
      return createGitLabPullRequestReviewComment({
        input,
        repository,
        fetchImpl,
        apiBaseUrl,
        tokenHeader,
        mergeRequestPath,
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

      throw new Error(await buildSourceControlRequestFailureMessage(response));
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
    throw new Error(await buildSourceControlRequestFailureMessage(response));
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
  const { apiBaseUrl, owner, repo, token } = await resolveGiteaProviderContext(
    repository,
    'write',
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
    case 'create_pull_request_review_comment': {
      return createGiteaPullRequestReviewComment({
        input,
        repository,
        fetchImpl,
        apiBaseUrl,
        owner,
        repo,
        tokenHeader,
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
    await resolveBitbucketProviderContext(repository, 'write');
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
    case 'create_pull_request_review_comment': {
      return createBitbucketPullRequestReviewComment({
        input,
        repository,
        fetchImpl,
        commentsUrl,
        tokenHeader,
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
        throw new Error(
          await buildSourceControlRequestFailureMessage(approveResponse),
        );
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
    await resolveAdoProviderContext(repository, 'write');
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
    case 'create_pull_request_review_comment': {
      return createAdoPullRequestReviewComment({
        input,
        repository,
        fetchImpl,
        tokenHeader,
        organizationApiBaseUrl,
        threadsPath,
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
          'api-version': ADO_CONNECTION_DATA_API_VERSION,
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
