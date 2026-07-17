import { execa } from 'execa';
import { z } from 'zod';

import {
  type PullRequest,
  type Issue,
  type ReviewComment,
  type IssueComment,
  type Commit,
  type TriggeringComment,
  pullRequestSchema,
  issueSchema,
  commitSchema,
  reviewCommentSchema,
  issueCommentSchema,
  isValidReviewComment,
  isValidIssueComment,
} from './schema';
import { resolveConfiguredGitHubAppSlug } from './resolve-app-slug';

export interface FetchParams {
  gitHubToken: string;
  repo: string;
}

export interface FetchPrParams extends FetchParams {
  prNumber: number;
}

type GitHubContentsEntry = {
  path?: string;
  type?: string;
};

function getGitHubApiErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const details = error as {
      stderr?: unknown;
      shortMessage?: unknown;
      message?: unknown;
    };

    const parts = [
      details.stderr,
      details.shortMessage,
      details.message,
    ].filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function isGitHubHttpNotFoundError(error: unknown): boolean {
  return /\bHTTP 404\b/i.test(getGitHubApiErrorMessage(error));
}

function getRepositoryContentsApiPath({
  repo,
  path,
  ref,
}: {
  repo: string;
  path: string;
  ref?: string;
}): string {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');

  return `repos/${repo}/contents/${encodedPath}${query}`;
}

async function fetchDirectoryFilePaths({
  gitHubToken,
  repo,
  path,
  ref,
}: FetchParams & {
  path: string;
  ref?: string;
}): Promise<string[]> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const { stdout } = await execa(
      'gh',
      ['api', getRepositoryContentsApiPath({ repo, path, ref })],
      { env },
    );

    const parsed = JSON.parse(stdout) as
      | GitHubContentsEntry[]
      | GitHubContentsEntry;

    if (!Array.isArray(parsed)) {
      return parsed.type === 'file' && typeof parsed.path === 'string'
        ? [parsed.path]
        : [];
    }

    const filePaths: string[] = [];

    for (const entry of parsed) {
      if (entry.type === 'file' && typeof entry.path === 'string') {
        filePaths.push(entry.path);
      } else if (entry.type === 'dir' && typeof entry.path === 'string') {
        filePaths.push(
          ...(await fetchDirectoryFilePaths({
            gitHubToken,
            repo,
            path: entry.path,
            ref,
          })),
        );
      }
    }

    return filePaths;
  } catch (error) {
    if (isGitHubHttpNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

export async function fetchFileContent({
  gitHubToken,
  repo,
  path,
  ref,
}: FetchParams & {
  path: string;
  ref?: string;
}): Promise<string | null> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const { stdout } = await execa(
      'gh',
      ['api', getRepositoryContentsApiPath({ repo, path, ref })],
      { env },
    );

    const parsed = JSON.parse(stdout) as {
      content?: string;
      encoding?: string;
      type?: string;
    };

    if (parsed.type !== 'file' || typeof parsed.content !== 'string') {
      return null;
    }

    if (parsed.encoding === 'base64') {
      return Buffer.from(parsed.content.replace(/\n/g, ''), 'base64').toString(
        'utf-8',
      );
    }

    return parsed.content;
  } catch (error) {
    if (isGitHubHttpNotFoundError(error)) {
      return null;
    }

    console.error(
      `[fetchFileContent] failed to fetch ${path}: ${getGitHubApiErrorMessage(error)}`,
    );

    return null;
  }
}

export async function fetchRepositoryTree({
  gitHubToken,
  repo,
  ref,
}: FetchParams & {
  ref: string;
}): Promise<string[]> {
  const env = { GH_TOKEN: gitHubToken };
  let treePaths: string[] = [];

  try {
    const { stdout } = await execa(
      'gh',
      ['api', `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`],
      { env },
    );

    const parsed = JSON.parse(stdout) as {
      truncated?: boolean;
      tree?: Array<{ path?: string; type?: string }>;
    };

    if (!Array.isArray(parsed.tree)) {
      return [];
    }

    treePaths = parsed.tree
      .filter(
        (entry): entry is { path: string; type: string } =>
          entry.type === 'blob' && typeof entry.path === 'string',
      )
      .map((entry) => entry.path);

    if (!parsed.truncated) {
      return treePaths;
    }

    const rulesPaths = await fetchDirectoryFilePaths({
      gitHubToken,
      repo,
      path: '.roomote/rules',
      ref,
    });

    return Array.from(new Set([...treePaths, ...rulesPaths]));
  } catch (error) {
    console.error(
      `[fetchRepositoryTree] failed to fetch tree for ${repo}@${ref}: ${getGitHubApiErrorMessage(error)}`,
    );

    return treePaths;
  }
}

export async function fetchPr({
  gitHubToken,
  repo,
  prNumber,
}: FetchPrParams): Promise<PullRequest> {
  const env = { GH_TOKEN: gitHubToken };

  const result = await execa(
    'gh',
    [
      'pr',
      'view',
      prNumber.toString(),
      '--repo',
      repo,
      '--json',
      'id,number,title,body,author,state,url,headRefName,baseRefName,baseRefOid,headRefOid,mergeable,isDraft,createdAt,updatedAt,closingIssuesReferences',
    ],
    { env },
  );

  try {
    return pullRequestSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    console.error(
      `[fetchPr] failed to parse PR: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
}

export async function fetchIssue({
  gitHubToken,
  repo,
  issueNumber,
}: FetchParams & { issueNumber: number }): Promise<Issue | null> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const { stdout } = await execa(
      'gh',
      [
        'issue',
        'view',
        issueNumber.toString(),
        '--repo',
        repo,
        '--json',
        'number,title,body,author,state,url,createdAt,updatedAt,comments',
      ],
      { env },
    );

    return issueSchema.parse(JSON.parse(stdout));
  } catch (error) {
    console.error(
      `[fetchIssue] failed to parse issue: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

export async function fetchDiff({
  gitHubToken,
  repo,
  prNumber,
}: FetchPrParams): Promise<{
  diff: string | undefined;
  changedFiles: string[];
}> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const { stdout: diff } = await execa(
      'gh',
      ['pr', 'diff', prNumber.toString(), '--repo', repo, '--patch'],
      { env },
    );

    return { diff, changedFiles: extractDiffFiles(diff) };
  } catch (error) {
    console.error(
      `[fetchDiff] failed to get diff: ${error instanceof Error ? error.message : String(error)}`,
    );

    return { diff: undefined, changedFiles: [] };
  }
}

export async function fetchDiffInRange({
  gitHubToken,
  repo,
  range,
}: FetchParams & { range: [string, string] }): Promise<{
  diff: string | undefined;
  changedFiles: string[];
}> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const { stdout: diff } = await execa(
      'gh',
      [
        'api',
        `repos/${repo}/compare/${range[0]}...${range[1]}`,
        '-H',
        'Accept: application/vnd.github.v3.diff',
      ],
      { env },
    );

    return { diff, changedFiles: extractDiffFiles(diff) };
  } catch (error) {
    console.error(
      `[fetchDiffInRange] failed to get diff: ${error instanceof Error ? error.message : String(error)}`,
    );

    return { diff: undefined, changedFiles: [] };
  }
}

export async function fetchReviewComments({
  gitHubToken,
  repo,
  prNumber,
}: FetchPrParams): Promise<ReviewComment[]> {
  const env = { GH_TOKEN: gitHubToken };

  const result = await execa(
    'gh',
    ['api', `repos/${repo}/pulls/${prNumber}/comments`],
    { env },
  );

  // isValidReviewComment classifies the deployment's own bot login from the
  // cached configured slug.
  await resolveConfiguredGitHubAppSlug();

  try {
    return z
      .array(reviewCommentSchema)
      .parse(JSON.parse(result.stdout))
      .filter(isValidReviewComment);
  } catch (error) {
    console.error(
      `[fetchReviewComments] failed to parse review comments: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
}

export async function fetchReviewComment({
  gitHubToken,
  repo,
  commentId,
}: FetchParams & { commentId: number }): Promise<ReviewComment> {
  const env = { GH_TOKEN: gitHubToken };

  const result = await execa(
    'gh',
    ['api', `repos/${repo}/pulls/comments/${commentId}`],
    { env },
  );

  try {
    return reviewCommentSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    console.error(
      `[fetchReviewComment] failed to parse review comment: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
}

export async function fetchIssueComments({
  gitHubToken,
  repo,
  prNumber,
}: FetchPrParams): Promise<IssueComment[]> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const { stdout } = await execa(
      'gh',
      ['api', `repos/${repo}/issues/${prNumber}/comments`],
      { env },
    );

    // isValidIssueComment classifies the deployment's own bot login from the
    // cached configured slug.
    await resolveConfiguredGitHubAppSlug();

    return z
      .array(issueCommentSchema)
      .parse(JSON.parse(stdout))
      .filter(isValidIssueComment);
  } catch (error) {
    console.error(
      `[fetchIssueComments] failed to parse issue comments: ${error instanceof Error ? error.message : String(error)}`,
    );

    return [];
  }
}

export async function fetchIssueComment({
  gitHubToken,
  repo,
  commentId,
}: FetchParams & { commentId: number }): Promise<IssueComment> {
  const env = { GH_TOKEN: gitHubToken };

  const result = await execa(
    'gh',
    ['api', `repos/${repo}/issues/comments/${commentId}`],
    { env },
  );

  try {
    return issueCommentSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    console.error(
      `[fetchIssueComment] failed to parse issue comment: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
}

export async function fetchCommitsInRange({
  gitHubToken,
  repo,
  prNumber,
  sha,
}: FetchPrParams & { sha?: string }): Promise<Commit[]> {
  const env = { GH_TOKEN: gitHubToken };

  try {
    const commitsResult = await execa(
      'gh',
      [
        'pr',
        'view',
        prNumber.toString(),
        '--repo',
        repo,
        '--json',
        'commits',
        '--jq',
        '[.commits[] | {sha: .oid, message: .messageHeadline}]',
      ],
      { env },
    );

    let commits = z.array(commitSchema).parse(JSON.parse(commitsResult.stdout));

    if (sha) {
      const index = commits.findIndex((commit) => commit.sha === sha);
      commits = index >= 0 ? commits.slice(index + 1) : commits;
    }

    return commits;
  } catch (error) {
    console.error(
      `[fetchCommitsInRange] failed to parse commits: ${error instanceof Error ? error.message : String(error)}`,
    );

    return [];
  }
}

export async function fetchTriggeringComment({
  gitHubToken,
  repo,
  commentId,
  commentBody,
}: FetchParams & {
  commentId?: number;
  commentBody?: string;
}): Promise<TriggeringComment> {
  let triggeringReviewComment: ReviewComment | undefined = undefined;
  let triggeringReviewCommentParent: ReviewComment | undefined = undefined;
  let triggeringIssueComment: IssueComment | undefined = undefined;
  let triggeringManualComment: string | undefined = undefined;

  if (commentId) {
    const params = { gitHubToken, repo, commentId };

    try {
      triggeringReviewComment = await fetchReviewComment(params);
    } catch (_error) {
      // This is expected if the comment is not a review comment.
    }

    // If it's a review comment with a parent, fetch the parent.
    if (triggeringReviewComment?.in_reply_to_id) {
      try {
        triggeringReviewCommentParent = await fetchReviewComment({
          gitHubToken,
          repo,
          commentId: triggeringReviewComment.in_reply_to_id,
        });
      } catch (_error) {
        // Already logged.
      }
    }

    // If not a review comment, try issue comment.
    if (!triggeringReviewComment) {
      try {
        triggeringIssueComment = await fetchIssueComment(params);
      } catch (_error) {
        // Already logged.
      }
    }
  } else {
    triggeringManualComment = commentBody;
  }

  if (triggeringReviewComment) {
    return {
      commentType: 'review',
      comment: triggeringReviewComment,
      inReplyTo: triggeringReviewCommentParent,
    };
  } else if (triggeringIssueComment) {
    return { commentType: 'issue', comment: triggeringIssueComment };
  } else if (triggeringManualComment) {
    return { commentType: 'manual', comment: triggeringManualComment };
  } else {
    console.error(
      `[fetchTriggeringComment] failed to find triggering comment: ${commentId}`,
    );

    throw new Error('Failed to find triggering comment.');
  }
}

function extractDiffFiles(diff: string): string[] {
  const changedFilesMatch = diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm);

  return Array.from(changedFilesMatch, (match) => match[1]).filter(
    (file): file is string => typeof file === 'string' && file.length > 0,
  );
}
