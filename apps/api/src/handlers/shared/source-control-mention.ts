import type { FastAgentActiveTask } from '@roomote/cloud-agents/server';
import {
  findActiveGitHubPrReviewTask,
  findReusableGitHubIssueTaskOwner,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

export const SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE =
  "I saw the mention, but I couldn't start a conversation right now. Please try again in a moment.";

function formatQuotedText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * What a Session reads with a pull request mention on a non-GitHub provider:
 * the pull request, the comment that mentioned Roomote, and where replies go.
 */
export function buildSourceControlPullRequestMentionContext({
  providerLabel,
  pullRequestLabel,
  repositoryFullName,
  number,
  title,
  body,
  headRef,
  baseRef,
  authorLogin,
  commenter,
  commentBody,
}: {
  providerLabel: string;
  pullRequestLabel: string;
  repositoryFullName: string;
  number: number;
  title: string;
  body?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  authorLogin?: string | null;
  commenter: string;
  commentBody: string;
}): string {
  const trimmedBody = body?.trim();
  return [
    `<${providerLabel.toLowerCase().replace(/\s+/g, '_')}_pull_request>`,
    `Repository: ${repositoryFullName}`,
    `${pullRequestLabel}: #${number} - ${title}`,
    ...(headRef ? [`Head branch: ${headRef}`] : []),
    ...(baseRef ? [`Target branch: ${baseRef}`] : []),
    ...(authorLogin ? [`Author: ${authorLogin}`] : []),
    ...(trimmedBody ? ['', 'Body:', formatQuotedText(trimmedBody)] : []),
    `</${providerLabel.toLowerCase().replace(/\s+/g, '_')}_pull_request>`,
    '<triggering_comment>',
    `${commenter} mentioned Roomote in a comment on the ${pullRequestLabel.toLowerCase()}:`,
    formatQuotedText(commentBody),
    '</triggering_comment>',
    `This conversation is a ${providerLabel} ${pullRequestLabel.toLowerCase()} discussion. Your replies post as comments on it, so keep them concise. Delegated tasks check out its source branch.`,
  ].join('\n');
}

/** The issue or work item counterpart of the pull request context. */
export function buildSourceControlIssueMentionContext({
  providerLabel,
  issueLabel,
  repositoryFullName,
  number,
  title,
  body,
  url,
  authorLogin,
  commenter,
  commentBody,
  extraLines = [],
}: {
  providerLabel: string;
  issueLabel: string;
  repositoryFullName: string;
  number: number;
  title: string;
  body?: string | null;
  url?: string | null;
  authorLogin?: string | null;
  commenter: string;
  commentBody: string;
  extraLines?: string[];
}): string {
  const tag = `${providerLabel.toLowerCase().replace(/\s+/g, '_')}_${issueLabel.toLowerCase().replace(/\s+/g, '_')}`;
  const trimmedBody = body?.trim();
  return [
    url ? `<${tag} url="${url}">` : `<${tag}>`,
    `Repository: ${repositoryFullName}`,
    `${issueLabel}: #${number} - ${title}`,
    ...(authorLogin ? [`Author: ${authorLogin}`] : []),
    ...extraLines,
    ...(trimmedBody
      ? ['', 'Body (context only):', formatQuotedText(trimmedBody)]
      : []),
    `</${tag}>`,
    '<triggering_comment>',
    `${commenter} mentioned Roomote in a comment on the ${issueLabel.toLowerCase()}:`,
    formatQuotedText(commentBody),
    '</triggering_comment>',
    `This conversation is a ${providerLabel} ${issueLabel.toLowerCase()} discussion. Your replies post as comments on it, so keep them concise. Delegated tasks run in the environment mapped to this repository and link the ${issueLabel.toLowerCase()}.`,
  ].join('\n');
}

/**
 * Tasks the Session may steer on this turn: a task that already owns the
 * pull request, and an in-flight review of the current head.
 */
export async function resolveSourceControlPullRequestActiveTasks({
  provider,
  repositoryFullName,
  prNumber,
  branchName,
  headSha,
  host,
}: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  prNumber: number;
  branchName: string;
  headSha: string;
  /** The discussion's resolved host, which scopes the lookup to this instance. */
  host: string;
}): Promise<FastAgentActiveTask[]> {
  const [owner, review] = await Promise.all([
    findReusableGitHubPrFollowUpOwner({
      repoFullName: repositoryFullName,
      prNumber,
      branchName,
      sourceControlProvider: provider,
      host,
    }).catch(() => null),
    headSha
      ? findActiveGitHubPrReviewTask({
          repoFullName: repositoryFullName,
          prNumber,
          headSha,
          sourceControlProvider: provider,
          host,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const tasks = new Map<string, FastAgentActiveTask>();
  if (owner?.taskId) {
    tasks.set(owner.taskId, { taskId: owner.taskId, status: owner.status });
  }
  if (review?.taskId) {
    tasks.set(review.taskId, { taskId: review.taskId, status: review.status });
  }
  return [...tasks.values()];
}

export async function resolveSourceControlIssueActiveTasks({
  provider,
  repositoryFullName,
  issueNumber,
  host,
}: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  issueNumber: number;
  /** The discussion's resolved host, which scopes the lookup to this instance. */
  host: string;
}): Promise<FastAgentActiveTask[]> {
  const owner = await findReusableGitHubIssueTaskOwner({
    repoFullName: repositoryFullName,
    issueNumber,
    sourceControlProvider: provider,
    host,
  }).catch(() => null);
  return owner?.taskId ? [{ taskId: owner.taskId, status: owner.status }] : [];
}
