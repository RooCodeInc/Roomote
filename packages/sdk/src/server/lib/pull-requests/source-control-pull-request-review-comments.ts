import { type getOctokit } from '@roomote/github';
import {
  getSourceControlProviderLabel,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
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
  buildApiUrl,
  formatResponseBody,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';
import type {
  SourceControlPullRequestWriteInput,
  SourceControlPullRequestWriteResult,
} from './source-control-pull-request-writes';

type ReviewCommentInput = SourceControlPullRequestWriteInput;

const gitLabMergeRequestDiffRefsSchema = z
  .object({
    diff_refs: z
      .object({
        base_sha: z.string().nullable().optional(),
        start_sha: z.string().nullable().optional(),
        head_sha: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const gitLabNoteSchema = z
  .object({ id: z.union([z.number(), z.string()]) })
  .passthrough();

const gitLabDiscussionSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    notes: z.array(gitLabNoteSchema).optional(),
  })
  .passthrough();

const gitLabMergeRequestDiffEntrySchema = z
  .object({
    old_path: z.string().optional(),
    new_path: z.string().optional(),
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

export function assertReviewCommentInputFields(
  input: SourceControlPullRequestWriteInput,
): asserts input is ReviewCommentInput {
  requirePath(input);
  requireLine(input);
  requireBody(input);
}

export async function createGitHubPullRequestReviewComment({
  input,
  repository,
  octokit,
  owner,
  repo,
}: {
  input: ReviewCommentInput;
  repository: RepositoryRow;
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
}): Promise<SourceControlPullRequestWriteResult> {
  const path = requirePath(input);
  const line = requireLine(input);
  const side = resolveSide(input);
  const body = requireBody(input);
  // Resolve the head at write time so moved pull requests cannot create an
  // outdated comment from a caller-supplied commit.
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: input.prNumber,
  });

  try {
    const { data } = await octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: input.prNumber,
      commit_id: pullRequest.head.sha,
      path,
      line,
      side,
      ...(input.startLine !== undefined
        ? {
            start_line: input.startLine,
            start_side: input.startSide ?? side,
          }
        : {}),
      body,
    });

    return buildReviewCommentResult({
      input,
      provider: 'github',
      repository,
      commentId: String(data.id),
      url: data.html_url ?? null,
    });
  } catch (error) {
    if (getHttpErrorStatus(error) === 422) {
      throw anchorRejectionError(
        'github',
        input,
        error instanceof Error ? error.message : String(error),
      );
    }

    throw error;
  }
}

export async function createGitLabPullRequestReviewComment({
  input,
  repository,
  fetchImpl,
  apiBaseUrl,
  tokenHeader,
  mergeRequestPath,
}: {
  input: ReviewCommentInput;
  repository: RepositoryRow;
  fetchImpl: FetchImpl;
  apiBaseUrl: string;
  tokenHeader: { name: string; value: string };
  mergeRequestPath: string;
}): Promise<SourceControlPullRequestWriteResult> {
  const path = requirePath(input);
  const line = requireLine(input);
  const side = resolveSide(input);
  // GitLab positions require the merge request's current diff SHA triple.
  const mergeRequest = await requestJson({
    fetchImpl,
    url: buildApiUrl(apiBaseUrl, mergeRequestPath, {}),
    tokenHeader,
    schema: gitLabMergeRequestDiffRefsSchema,
    acceptedStatuses: [200],
  });
  const diffRefs = mergeRequest.diff_refs;

  if (!diffRefs?.base_sha || !diffRefs.start_sha || !diffRefs.head_sha) {
    throw new SourceControlWriteError(
      409,
      'GitLab has not computed diff refs for this merge request yet; retry shortly or carry the finding in the review summary comment instead.',
    );
  }

  const positionPaths = await resolveGitLabPositionPaths({
    fetchImpl,
    apiBaseUrl,
    tokenHeader,
    mergeRequestPath,
    path,
  });
  const response = await performRequest({
    fetchImpl,
    method: 'POST',
    url: buildApiUrl(apiBaseUrl, `${mergeRequestPath}/discussions`, {}),
    tokenHeader,
    body: {
      body: requireBody(input),
      position: {
        position_type: 'text',
        base_sha: diffRefs.base_sha,
        start_sha: diffRefs.start_sha,
        head_sha: diffRefs.head_sha,
        new_path: positionPaths.newPath,
        old_path: positionPaths.oldPath,
        ...(side === 'RIGHT' ? { new_line: line } : { old_line: line }),
      },
    },
  });

  if (response.status === 400) {
    throw anchorRejectionError(
      'gitlab',
      input,
      `GitLab could not map the position onto the merge request diff${await formatResponseBody(response)}; target a line changed in this merge request${
        positionPaths.warnings.length
          ? `. ${positionPaths.warnings.join(' ')}`
          : ''
      }`,
    );
  }

  if (![200, 201].includes(response.status)) {
    throw new Error(await buildSourceControlRequestFailureMessage(response));
  }

  const discussion = gitLabDiscussionSchema.parse(await response.json());
  const firstNote = discussion.notes?.[0];

  return buildReviewCommentResult({
    input,
    provider: 'gitlab',
    repository,
    threadId: String(discussion.id),
    commentId: firstNote ? String(firstNote.id) : null,
    warnings: [
      ...positionPaths.warnings,
      ...multiLineRangeWarnings('gitlab', input),
    ],
  });
}

export async function createGiteaPullRequestReviewComment({
  input,
  repository,
  fetchImpl,
  apiBaseUrl,
  owner,
  repo,
  tokenHeader,
}: {
  input: ReviewCommentInput;
  repository: RepositoryRow;
  fetchImpl: FetchImpl;
  apiBaseUrl: string;
  owner: string;
  repo: string;
  tokenHeader: { name: string; value: string };
}): Promise<SourceControlPullRequestWriteResult> {
  const line = requireLine(input);
  const side = resolveSide(input);
  // Gitea creates a review containing one positioned comment and anchors it
  // against the latest diff when commit_id is omitted.
  const response = await performRequest({
    fetchImpl,
    method: 'POST',
    url: buildApiUrl(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}/reviews`,
      {},
    ),
    tokenHeader,
    body: {
      event: 'COMMENT',
      body: '',
      comments: [
        {
          path: requirePath(input),
          body: requireBody(input),
          ...(side === 'RIGHT'
            ? { new_position: line }
            : { old_position: line }),
        },
      ],
    },
  });

  if (response.status === 422) {
    throw anchorRejectionError(
      'gitea',
      input,
      `Gitea rejected the review position${await formatResponseBody(response)}`,
    );
  }

  if (![200, 201].includes(response.status)) {
    throw new Error(await buildSourceControlRequestFailureMessage(response));
  }

  const review = giteaCreatedReviewSchema.parse(await response.json());
  return buildReviewCommentResult({
    input,
    provider: 'gitea',
    repository,
    threadId: String(review.id),
    url: review.html_url ?? null,
    warnings: multiLineRangeWarnings('gitea', input),
  });
}

export async function createBitbucketPullRequestReviewComment({
  input,
  repository,
  fetchImpl,
  commentsUrl,
  tokenHeader,
}: {
  input: ReviewCommentInput;
  repository: RepositoryRow;
  fetchImpl: FetchImpl;
  commentsUrl: string;
  tokenHeader: { name: string; value: string };
}): Promise<SourceControlPullRequestWriteResult> {
  const line = requireLine(input);
  const side = resolveSide(input);
  // Bitbucket uses destination (`to`) and source (`from`) line anchors.
  const comment = await requestJson({
    fetchImpl,
    method: 'POST',
    url: commentsUrl,
    tokenHeader,
    body: {
      content: { raw: requireBody(input) },
      inline: {
        path: requirePath(input),
        ...(side === 'RIGHT' ? { to: line } : { from: line }),
      },
    },
    schema: bitbucketCreatedCommentSchema,
  });
  const commentId =
    comment.id === undefined || comment.id === null ? null : String(comment.id);

  return buildReviewCommentResult({
    input,
    provider: 'bitbucket',
    repository,
    threadId: commentId,
    commentId,
    url: comment.links?.html?.href ?? null,
    warnings: multiLineRangeWarnings('bitbucket', input),
  });
}

export async function createAdoPullRequestReviewComment({
  input,
  repository,
  fetchImpl,
  tokenHeader,
  organizationApiBaseUrl,
  threadsPath,
}: {
  input: ReviewCommentInput;
  repository: RepositoryRow;
  fetchImpl: FetchImpl;
  tokenHeader: { name: string; value: string };
  organizationApiBaseUrl: string;
  threadsPath: string;
}): Promise<SourceControlPullRequestWriteResult> {
  const line = requireLine(input);
  const side = resolveSide(input);
  const path = requirePath(input);
  const start = { line: input.startLine ?? line, offset: 1 };
  const end = { line, offset: 1 };
  const thread = await createAdoCommentThread({
    fetchImpl,
    tokenHeader,
    organizationApiBaseUrl,
    threadsPath,
    content: requireBody(input),
    threadContext: {
      filePath: path.startsWith('/') ? path : `/${path}`,
      ...(side === 'RIGHT'
        ? { rightFileStart: start, rightFileEnd: end }
        : { leftFileStart: start, leftFileEnd: end }),
    },
  });

  return buildReviewCommentResult({
    input,
    provider: 'ado',
    repository,
    threadId: String(thread.id),
    commentId: getFirstAdoCommentId(thread),
  });
}

function requirePath(input: SourceControlPullRequestWriteInput): string {
  if (!input.path) {
    throw new SourceControlWriteError(
      400,
      `path is required for ${input.action}.`,
    );
  }
  return input.path;
}

function requireLine(input: SourceControlPullRequestWriteInput): number {
  if (input.line === undefined) {
    throw new SourceControlWriteError(
      400,
      `line is required for ${input.action}.`,
    );
  }
  if (input.startLine !== undefined && input.startLine > input.line) {
    throw new SourceControlWriteError(
      400,
      `startLine must not be greater than line (got startLine=${input.startLine}, line=${input.line}); line is the end of the range.`,
    );
  }
  return input.line;
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

function resolveSide(
  input: SourceControlPullRequestWriteInput,
): 'LEFT' | 'RIGHT' {
  return input.side ?? 'RIGHT';
}

function anchorRejectionError(
  provider: SourceControlProvider,
  input: SourceControlPullRequestWriteInput,
  detail: string,
): SourceControlWriteError {
  return new SourceControlWriteError(
    422,
    `${getSourceControlProviderLabel(provider)} rejected the inline comment anchor (path=${input.path}, line=${input.line}, side=${resolveSide(input)}): ${detail}. The anchor must target a line in the current pull request diff; re-check the hunk and retry once with a corrected anchor, or carry the finding in the review summary comment instead.`,
  );
}

function getHttpErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
}

function multiLineRangeWarnings(
  provider: SourceControlProvider,
  input: SourceControlPullRequestWriteInput,
): string[] {
  if (input.startLine === undefined) {
    return [];
  }
  return [
    `${getSourceControlProviderLabel(provider)} does not support multi-line comment positions through this surface; the comment is anchored to line ${input.line}.`,
  ];
}

async function resolveGitLabPositionPaths({
  fetchImpl,
  apiBaseUrl,
  tokenHeader,
  mergeRequestPath,
  path,
}: {
  fetchImpl: FetchImpl;
  apiBaseUrl: string;
  tokenHeader: { name: string; value: string };
  mergeRequestPath: string;
  path: string;
}): Promise<{ oldPath: string; newPath: string; warnings: string[] }> {
  // Renamed files require their distinct old and new paths. Scan all diff
  // pages with a defensive cap before falling back to the requested path.
  const maxPages = 50;
  const perPage = 100;

  for (let page = 1; page <= maxPages; page++) {
    const response = await performRequest({
      fetchImpl,
      url: buildApiUrl(apiBaseUrl, `${mergeRequestPath}/diffs`, {
        page,
        per_page: perPage,
      }),
      tokenHeader,
    });
    if (response.status !== 200) {
      break;
    }

    const entries = z
      .array(gitLabMergeRequestDiffEntrySchema)
      .parse(await response.json());
    const entry = entries.find(
      (candidate) => candidate.new_path === path || candidate.old_path === path,
    );
    if (entry) {
      return {
        oldPath: entry.old_path ?? path,
        newPath: entry.new_path ?? path,
        warnings: [],
      };
    }
    if (page === maxPages && entries.length === perPage) {
      return {
        oldPath: path,
        newPath: path,
        warnings: [
          `The merge request diff listing exceeded ${maxPages * perPage} files before ${path} was found; rename resolution fell back to the request path, so an anchor on a renamed file may be rejected.`,
        ],
      };
    }
    if (entries.length < perPage) {
      break;
    }
  }

  return { oldPath: path, newPath: path, warnings: [] };
}

function buildReviewCommentResult({
  input,
  provider,
  repository,
  threadId = null,
  commentId = null,
  url = null,
  warnings = [],
}: {
  input: ReviewCommentInput;
  provider: SourceControlProvider;
  repository: RepositoryRow;
  threadId?: string | null;
  commentId?: string | null;
  url?: string | null;
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
    applied: true,
    warnings,
  };
}
