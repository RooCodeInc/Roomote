import {
  findActiveGitHubPrReviewTask,
  findGitHubPullRequestLinkedTask,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import {
  getInstallationOctokit,
  Schemas as GitHubSchemas,
} from '@roomote/github';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import type { FastAgentActiveTask } from '@roomote/cloud-agents/server';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { toHostFromUrl } from '../utils';

import type {
  WebhookPullRequestCommentCreated,
  WebhookIssueCommentCreated,
  WebhookPullRequestReviewSubmitted,
} from './types';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { isMention } from './isMention';
import {
  fetchGitHubLinkedReferences,
  formatGitHubLinkedReferencesSection,
} from './linked-issue-pr-context';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';

type PullRequestMentionEvent =
  | WebhookPullRequestCommentCreated
  | WebhookIssueCommentCreated
  | WebhookPullRequestReviewSubmitted;

type MentionResponseTarget = {
  repositoryFullName: string;
  prNumber: number;
  reviewCommentId?: number;
};

type ReviewCommentSnapshot = {
  id: number;
  body: string;
  path?: string;
  diffHunk?: string;
  userLogin: string;
};

type GitHubRoutingHistoryContext = {
  issueComments: Array<{ author: string; body: string }>;
  reviewComments: Array<{ author: string; body: string; path?: string }>;
};

type PullRequestRoutingDetails = {
  branchName: string;
  prUrl: string;
  headSha: string;
};

const GITHUB_ROUTING_HISTORY_PAGE_SIZE = 100;

const FAST_UNAVAILABLE_COMMENT =
  "I saw the mention, but I couldn't start a conversation right now. Please try again in a moment.";

async function postMentionResponseComment({
  installationId,
  target,
  body,
}: {
  installationId: number;
  target: MentionResponseTarget;
  body: string;
}): Promise<void> {
  const { repositoryFullName, prNumber, reviewCommentId } = target;
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return;
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });

    if (reviewCommentId) {
      await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
        {
          owner,
          repo,
          pull_number: prNumber,
          comment_id: reviewCommentId,
          body,
        },
      );

      return;
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to post mention response comment on ${repositoryFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Acknowledges the mention the way chat surfaces do, with an eyes reaction
 * on the comment. Submitted reviews have no reaction API; the reply itself
 * is the acknowledgement there.
 */
async function acknowledgeMentionBestEffort({
  installationId,
  eventPayload,
}: {
  installationId: number;
  eventPayload: PullRequestMentionEvent;
}): Promise<void> {
  if (!('comment' in eventPayload)) {
    return;
  }
  const [owner, repo] = eventPayload.repository.full_name.split('/');
  if (!owner || !repo) {
    return;
  }
  try {
    const octokit = await getInstallationOctokit({ installationId });
    if ('pull_request' in eventPayload) {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: eventPayload.comment.id,
        content: 'eyes',
      });
      return;
    }
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: eventPayload.comment.id,
      content: 'eyes',
    });
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to acknowledge mention on ${eventPayload.repository.full_name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getMentionResponseTarget(
  eventPayload: PullRequestMentionEvent,
): MentionResponseTarget {
  if ('comment' in eventPayload && 'pull_request' in eventPayload) {
    return {
      repositoryFullName: eventPayload.repository.full_name,
      prNumber: eventPayload.pull_request.number,
      reviewCommentId:
        eventPayload.comment.in_reply_to_id ?? eventPayload.comment.id,
    };
  }

  const prNumber =
    'issue' in eventPayload
      ? eventPayload.issue.number
      : eventPayload.pull_request.number;

  return {
    repositoryFullName: eventPayload.repository.full_name,
    prNumber,
  };
}

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this PR with the current ${PRODUCT_NAME} GitHub setup.`;
}

async function fetchReviewCommentSnapshot({
  installationId,
  repositoryFullName,
  commentId,
}: {
  installationId: number;
  repositoryFullName: string;
  commentId: number;
}): Promise<ReviewCommentSnapshot | null> {
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return null;
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}',
      {
        owner,
        repo,
        comment_id: commentId,
      },
    );
    const comment = response.data as {
      id?: number;
      body?: string;
      path?: string;
      diff_hunk?: string;
      user?: { login?: string };
    };

    if (
      typeof comment.id !== 'number' ||
      typeof comment.body !== 'string' ||
      typeof comment.user?.login !== 'string'
    ) {
      return null;
    }

    return {
      id: comment.id,
      body: comment.body,
      path: typeof comment.path === 'string' ? comment.path : undefined,
      diffHunk:
        typeof comment.diff_hunk === 'string' ? comment.diff_hunk : undefined,
      userLogin: comment.user.login,
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to fetch review comment ${commentId} on ${repositoryFullName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function formatQuotedText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function formatCompactGitHubIssueComments(
  comments: Array<{ author: string; body: string }>,
): string | undefined {
  if (comments.length === 0) {
    return undefined;
  }

  const recentComments = comments.slice(-10);
  const omittedCount = comments.length - recentComments.length;
  const lines = ['## Top-level Comments', ''];

  for (const comment of recentComments) {
    lines.push(`Top-level comment from @${comment.author}:`);
    lines.push(formatQuotedText(comment.body));
    lines.push('');
  }

  if (omittedCount > 0) {
    lines.push(`... ${omittedCount} older top-level comments omitted.`);
  }

  return lines.join('\n').trim();
}

function formatCompactGitHubReviewComments(
  comments: Array<{ author: string; body: string; path?: string }>,
): string | undefined {
  if (comments.length === 0) {
    return undefined;
  }

  const recentComments = comments.slice(-10);
  const omittedCount = comments.length - recentComments.length;
  const lines = ['## Review Comments', ''];

  for (const comment of recentComments) {
    const pathSuffix = comment.path ? ` on \`${comment.path}\`` : '';
    lines.push(`Review comment from @${comment.author}${pathSuffix}:`);
    lines.push(formatQuotedText(comment.body));
    lines.push('');
  }

  if (omittedCount > 0) {
    lines.push(`... ${omittedCount} older review comments omitted.`);
  }

  return lines.join('\n').trim();
}

function buildCompactPullRequestDetails({
  repository,
  prNumber,
  prTitle,
  prBody,
  headRefName,
  prAuthorLogin,
}: {
  repository: string;
  prNumber: number;
  prTitle: string;
  prBody?: string;
  headRefName?: string;
  prAuthorLogin?: string;
}): string {
  const lines = [
    `Repository: ${repository}`,
    `Pull request: #${prNumber} - ${prTitle}`,
  ];

  if (headRefName) {
    lines.push(`Head branch: ${headRefName}`);
  }

  if (prAuthorLogin) {
    lines.push(`PR author: @${prAuthorLogin}`);
  }

  const trimmedBody = prBody?.trim();
  if (trimmedBody) {
    lines.push('', 'Body:', trimmedBody);
  }

  return lines.join('\n');
}

function buildCompactTriggeringComment({
  commenter,
  commentBody,
}: {
  commenter: string;
  commentBody: string;
}): string {
  return `${commenter} mentioned Roomote in the following GitHub pull request discussion:\n${formatQuotedText(commentBody)}`;
}

function buildReviewCommentTriggeringComment({
  commenter,
  commentBody,
}: {
  commenter: string;
  commentBody: string;
}): string {
  return `${commenter} mentioned Roomote in the following review comment:\n${formatQuotedText(commentBody)}`;
}

function buildReviewReplyTriggeringComment({
  commenter,
  commentBody,
  parentComment,
}: {
  commenter: string;
  commentBody: string;
  parentComment: ReviewCommentSnapshot;
}): string {
  const parentIsRoomote = GitHubSchemas.isRoomoteGitHubLogin(
    parentComment.userLogin,
  );
  const lines = [
    parentIsRoomote
      ? `${commenter} replied to Roomote's review comment #${parentComment.id}:`
      : `${commenter} mentioned Roomote in a reply to review comment #${parentComment.id}:`,
    formatQuotedText(commentBody),
    '',
    parentIsRoomote
      ? `Roomote (${parentComment.userLogin}) wrote the following review comment that this reply is in response to:`
      : `${parentComment.userLogin} wrote the following review comment that this reply is in response to:`,
    formatQuotedText(parentComment.body),
  ];

  if (parentComment.path && parentComment.diffHunk) {
    lines.push(
      '',
      '```diff',
      parentComment.path,
      parentComment.diffHunk,
      '```',
    );
  }

  return lines.join('\n');
}

async function buildTriggeringCommentContext({
  eventPayload,
  installationId,
  repositoryFullName,
  commenter,
  commentBody,
  parentComment: knownParentComment,
}: {
  eventPayload:
    | WebhookPullRequestCommentCreated
    | WebhookIssueCommentCreated
    | WebhookPullRequestReviewSubmitted;
  installationId: number;
  repositoryFullName: string;
  commenter: string;
  commentBody: string;
  /** The review thread parent when the mention gate already fetched it. */
  parentComment?: ReviewCommentSnapshot | null;
}): Promise<string> {
  if ('comment' in eventPayload && 'pull_request' in eventPayload) {
    const reviewComment = eventPayload.comment;

    if (reviewComment.in_reply_to_id) {
      const parentComment =
        knownParentComment ??
        (await fetchReviewCommentSnapshot({
          installationId,
          repositoryFullName,
          commentId: reviewComment.in_reply_to_id,
        }));

      if (parentComment) {
        return buildReviewReplyTriggeringComment({
          commenter,
          commentBody,
          parentComment,
        });
      }
    }

    return buildReviewCommentTriggeringComment({ commenter, commentBody });
  }

  return buildCompactTriggeringComment({ commenter, commentBody });
}

async function listGitHubRoutingHistoryPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;

  while (true) {
    const pageItems = await fetchPage(page);

    if (pageItems.length === 0) {
      break;
    }

    items.push(...pageItems);

    if (pageItems.length < GITHUB_ROUTING_HISTORY_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return items;
}

async function getGitHubRoutingHistoryContext({
  installationId,
  repositoryFullName,
  prNumber,
}: {
  installationId: number;
  repositoryFullName: string;
  prNumber: number;
}): Promise<GitHubRoutingHistoryContext> {
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return { issueComments: [], reviewComments: [] };
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const issueCommentsRequest = octokit.rest.issues.listComments
      ? listGitHubRoutingHistoryPages((page) =>
          octokit.rest.issues
            .listComments({
              owner,
              repo,
              issue_number: prNumber,
              per_page: GITHUB_ROUTING_HISTORY_PAGE_SIZE,
              page,
            })
            .then((response) => response.data),
        )
      : Promise.resolve([]);
    const reviewCommentsRequest = octokit.rest.pulls.listReviewComments
      ? listGitHubRoutingHistoryPages((page) =>
          octokit.rest.pulls
            .listReviewComments({
              owner,
              repo,
              pull_number: prNumber,
              per_page: GITHUB_ROUTING_HISTORY_PAGE_SIZE,
              page,
            })
            .then((response) => response.data),
        )
      : Promise.resolve([]);
    const [issueCommentsResult, reviewCommentsResult] =
      await Promise.allSettled([issueCommentsRequest, reviewCommentsRequest]);

    return {
      issueComments:
        issueCommentsResult.status === 'fulfilled'
          ? issueCommentsResult.value
              .map((comment) => ({
                author: comment.user?.login?.trim() || 'unknown',
                body: comment.body?.trim() || '',
              }))
              .filter((comment) => comment.body.length > 0)
          : [],
      reviewComments:
        reviewCommentsResult.status === 'fulfilled'
          ? reviewCommentsResult.value
              .map((comment) => ({
                author: comment.user?.login?.trim() || 'unknown',
                body: comment.body?.trim() || '',
                path: comment.path?.trim() || undefined,
              }))
              .filter((comment) => comment.body.length > 0)
          : [],
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to fetch GitHub routing history for ${repositoryFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return { issueComments: [], reviewComments: [] };
  }
}

async function getPullRequestRoutingDetails({
  eventPayload,
  installationId,
  repositoryFullName,
  prNumber,
}: {
  eventPayload:
    | WebhookPullRequestCommentCreated
    | WebhookIssueCommentCreated
    | WebhookPullRequestReviewSubmitted;
  installationId: number;
  repositoryFullName: string;
  prNumber: number;
}): Promise<PullRequestRoutingDetails> {
  if ('pull_request' in eventPayload) {
    const branchName = eventPayload.pull_request.head?.ref ?? '';
    const prUrl = eventPayload.pull_request.html_url ?? '';
    const headSha = eventPayload.pull_request.head?.sha ?? '';

    if (branchName && prUrl && headSha) {
      return { branchName, prUrl, headSha };
    }
  }

  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return { branchName: '', prUrl: '', headSha: '' };
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const pullRequest = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return {
      branchName: pullRequest.data.head.ref ?? '',
      prUrl: pullRequest.data.html_url ?? '',
      headSha: pullRequest.data.head.sha ?? '',
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to fetch PR details for ${repositoryFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { branchName: '', prUrl: '', headSha: '' };
  }
}

/**
 * What the Session reads with a pull request mention: the pull request, the
 * comment that mentioned Roomote (with the review thread it replies to), the
 * discussion so far, and any linked issues or pull requests.
 */
function buildPullRequestMentionContext({
  details,
  triggeringComment,
  history,
  linkedReferencesSection,
}: {
  details: string;
  triggeringComment: string;
  history: GitHubRoutingHistoryContext;
  linkedReferencesSection?: string;
}): string {
  return [
    '<github_pull_request>',
    details,
    '</github_pull_request>',
    '<triggering_comment>',
    triggeringComment,
    '</triggering_comment>',
    ...(history.issueComments.length > 0
      ? [
          '<pull_request_discussion>',
          formatCompactGitHubIssueComments(history.issueComments) ?? '',
          '</pull_request_discussion>',
        ]
      : []),
    ...(history.reviewComments.length > 0
      ? [
          '<pull_request_review_comments>',
          formatCompactGitHubReviewComments(history.reviewComments) ?? '',
          '</pull_request_review_comments>',
        ]
      : []),
    ...(linkedReferencesSection ? [linkedReferencesSection] : []),
    'This conversation is a GitHub pull request discussion. Your replies post as comments on the pull request, so keep them concise. Delegated tasks check out the head branch of this pull request.',
  ].join('\n');
}

/**
 * Tasks the Session may steer on this turn: a task that already owns this
 * pull request, and an in-flight review of the current head.
 */
async function resolvePullRequestActiveTasks({
  repositoryFullName,
  prNumber,
  branchName,
  headSha,
  host,
}: {
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
      host,
    }).catch(() => null),
    headSha
      ? findActiveGitHubPrReviewTask({
          repoFullName: repositoryFullName,
          prNumber,
          headSha,
          sourceControlProvider: 'github',
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

/**
 * A reply inside a review thread Roomote opened is addressed to Roomote the
 * way GitHub trains people to reply to a reviewer, so it counts as a mention
 * without the @-handle. Only pull requests no Roomote task is linked to
 * qualify: on a Roomote-opened pull request the review-feedback pipeline
 * already batches these replies into the owning Session with its Resolve /
 * Dismiss actions, and handling them here too would answer twice. The
 * linkage is durable, so a finished task still owns its pull request.
 */
async function resolveImplicitReviewThreadMention({
  eventPayload,
  installationId,
}: {
  eventPayload: PullRequestMentionEvent;
  installationId: number;
}): Promise<{ parentComment: ReviewCommentSnapshot } | null> {
  if (!('comment' in eventPayload) || !('pull_request' in eventPayload)) {
    return null;
  }
  const { comment, pull_request: pullRequest, repository } = eventPayload;
  const commenterLogin = comment.user?.login;
  if (
    !comment.in_reply_to_id ||
    !commenterLogin ||
    GitHubSchemas.isRoomoteGitHubLogin(commenterLogin)
  ) {
    return null;
  }

  const parentComment = await fetchReviewCommentSnapshot({
    installationId,
    repositoryFullName: repository.full_name,
    commentId: comment.in_reply_to_id,
  });
  if (
    !parentComment ||
    !GitHubSchemas.isRoomoteGitHubLogin(parentComment.userLogin)
  ) {
    return null;
  }

  const linkedTask = await findGitHubPullRequestLinkedTask({
    repoFullName: repository.full_name,
    prNumber: pullRequest.number,
    host: toHostFromUrl(pullRequest.html_url ?? '') ?? 'github.com',
  }).catch(() => null);
  if (linkedTask) {
    return null;
  }

  return { parentComment };
}

/**
 * Every @mention on a pull request enters the pull request's Fast Session.
 * The Session reads the discussion, replies as a comment, and delegates work
 * to a task on the pull request's branch when the request needs one. A reply
 * in a review thread Roomote opened enters the same way without an @mention.
 */
export async function handlePrComment(
  eventPayload: PullRequestMentionEvent,
): Promise<WebhookResponse> {
  const { installation, repository, sender, ...rest } = eventPayload;
  const isSubmittedReview = 'review' in rest;
  const mention = isSubmittedReview ? rest.review : rest.comment;
  const githubInstallationId = installation?.id;

  const explicitMention = isMention({
    body: mention.body ?? '',
    user: mention.user ? { login: mention.user.login } : null,
  });
  let reviewThreadParent: ReviewCommentSnapshot | null = null;
  if (!explicitMention) {
    const implicitMention = githubInstallationId
      ? await resolveImplicitReviewThreadMention({
          eventPayload,
          installationId: githubInstallationId,
        })
      : null;
    if (!implicitMention) {
      return { status: 'ok', message: 'no_mention' };
    }
    reviewThreadParent = implicitMention.parentComment;
  }

  const mentionResponseTarget = getMentionResponseTarget(eventPayload);

  if (!githubInstallationId) {
    return { status: 'error', message: 'no_installation' };
  }

  const pr = 'issue' in rest ? rest.issue : rest.pull_request;

  // The commenter must be a linked Roomote user: the Session runs as them.
  // The non-review workflow resolves the repository and the linked account
  // without the Review Code automation gates, which do not apply to a
  // conversation.
  const reviewerGate = await getGitHubAutomationTargets({
    workflow: 'pr_conflict_resolve',
    installation,
    repository,
    sender,
    requireLinkedSenderAccount: true,
  });

  if (reviewerGate.status === 'error') {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body:
        reviewerGate.code === 'account_link_required'
          ? await buildSourceControlAccountLinkRequiredMessage('github')
          : buildReviewerGateMissComment(),
    });

    return {
      status: 'ok',
      message:
        reviewerGate.code === 'account_link_required'
          ? 'account_link_required'
          : 'reviewer_gate_miss',
    };
  }

  const commenter = reviewerGate.targets[0];
  const commenterUserId = commenter?.properties.userId;

  if (!commenter) {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: buildReviewerGateMissComment(),
    });

    return { status: 'ok', message: 'reviewer_gate_miss' };
  }

  if (!commenterUserId) {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: await buildSourceControlAccountLinkRequiredMessage('github'),
    });

    return { status: 'ok', message: 'account_link_required' };
  }

  await acknowledgeMentionBestEffort({
    installationId: githubInstallationId,
    eventPayload,
  });

  const [details, history, linkedReferences, triggeringComment] =
    await Promise.all([
      getPullRequestRoutingDetails({
        eventPayload,
        installationId: githubInstallationId,
        repositoryFullName: repository.full_name,
        prNumber: pr.number,
      }),
      getGitHubRoutingHistoryContext({
        installationId: githubInstallationId,
        repositoryFullName: repository.full_name,
        prNumber: pr.number,
      }),
      fetchGitHubLinkedReferences({
        installationId: githubInstallationId,
        repositoryFullName: repository.full_name,
        issueOrPrNumber: pr.number,
      }),
      buildTriggeringCommentContext({
        eventPayload,
        installationId: githubInstallationId,
        repositoryFullName: repository.full_name,
        commenter: sender.login,
        commentBody: mention.body ?? '',
        parentComment: reviewThreadParent,
      }),
    ]);

  const host =
    commenter.repo.host ??
    toHostFromUrl(
      details.prUrl ||
        `https://github.com/${repository.full_name}/pull/${pr.number}`,
    ) ??
    'github.com';
  const discussion: SourceControlFastDiscussion = {
    provider: 'github',
    host,
    repositoryFullName: repository.full_name,
    kind: 'pull',
    number: pr.number,
    ...(mentionResponseTarget.reviewCommentId
      ? { reviewCommentId: String(mentionResponseTarget.reviewCommentId) }
      : {}),
  };
  const activeTasks = await resolvePullRequestActiveTasks({
    repositoryFullName: repository.full_name,
    prNumber: pr.number,
    branchName: details.branchName,
    headSha: details.headSha,
    host,
  });
  const currentMessageId = isSubmittedReview
    ? `github:review:${rest.review.id}`
    : `github:comment:${rest.comment.id}`;

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: commenterUserId,
    senderDisplayName: sender.login,
    question: mention.body ?? '',
    agentContext: buildPullRequestMentionContext({
      details: buildCompactPullRequestDetails({
        repository: repository.full_name,
        prNumber: pr.number,
        prTitle: pr.title,
        prBody: pr.body ?? undefined,
        headRefName: details.branchName || undefined,
        prAuthorLogin: pr.user?.login ?? undefined,
      }),
      triggeringComment,
      history,
      linkedReferencesSection:
        formatGitHubLinkedReferencesSection(linkedReferences),
    }),
    currentMessageId,
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: FAST_UNAVAILABLE_COMMENT,
    });

    return { status: 'error', message: 'fast_unavailable' };
  }

  return {
    status: 'ok',
    message: 'fast_session_queued',
    metadata: { fastConversationId: started.fastConversationId },
  };
}
