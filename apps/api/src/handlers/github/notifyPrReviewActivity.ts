import { createHash } from 'node:crypto';

import {
  REVIEW_STATUS_END_MARKER,
  REVIEW_STATUS_START_MARKER,
  REVIEW_SUMMARY_MARKER,
  getMarkedSection,
  isReviewInProgressStatusLine,
} from '@roomote/cloud-agents/server';
import { Schemas as GitHubSchemas } from '@roomote/github';
import {
  completeGithubPrReviewCheckFromSummary,
  enqueuePrReviewNotification,
  startPrReviewNotificationCycle,
  type EnqueuePrReviewNotificationInput,
  type StartPrReviewNotificationCycleInput,
} from '@roomote/sdk/server';

import { isMention } from './isMention';
import type {
  WebhookIssueCommentCreated,
  WebhookIssueCommentEdited,
  WebhookPullRequestCommentCreated,
  WebhookPullRequestReviewSubmitted,
} from './types';

type PrReviewActivityWebhookPayload =
  | WebhookIssueCommentCreated
  | WebhookIssueCommentEdited
  | WebhookPullRequestReviewSubmitted
  | WebhookPullRequestCommentCreated;

type PrReviewSummaryWebhookPayload =
  | WebhookIssueCommentCreated
  | WebhookIssueCommentEdited;

type GitHubWebhookContext = { deliveryId?: string };

const MAX_SUMMARY_LENGTH = 300;
const MAX_REVIEW_BODY_LENGTH = 10_000;

function getReviewBody(value: string | null | undefined): string | undefined {
  const body = value?.trim();
  return body ? body.slice(0, MAX_REVIEW_BODY_LENGTH) : undefined;
}

function isExternalBotAuthor(
  user: { login?: string; type?: string } | null | undefined,
): boolean {
  return (
    user?.type === 'Bot' &&
    (!user.login || !GitHubSchemas.isManagedRoomoteGitHubLogin(user.login))
  );
}

function getAutomatedAuthorMetadata(
  user: { id?: number; type?: string } | null | undefined,
): { automatedAuthorId: string } | Record<string, never> {
  return user?.type === 'Bot' && typeof user.id === 'number'
    ? { automatedAuthorId: `github:${user.id}` }
    : {};
}

function getObservedAt(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : Date.now();
}

function getReviewTaskId(body: string): string | undefined {
  return body.match(/\/task\/([a-z0-9]+)(?:[/?#)]|$)/i)?.[1];
}

function getIssueCommentRevision(
  eventPayload: PrReviewSummaryWebhookPayload,
  context: GitHubWebhookContext,
): string {
  if (eventPayload.comment.updated_at) {
    return eventPayload.comment.updated_at;
  }

  if ('changes' in eventPayload) {
    if (!context.deliveryId) {
      throw new Error(
        'GitHub issue_comment.edited without updated_at requires a delivery id',
      );
    }

    return `delivery:${context.deliveryId}`;
  }

  return eventPayload.comment.created_at;
}

function getTimestampLessSummaryCycleId(
  commentId: number,
  inProgressBody: string,
): string {
  const bodyFingerprint = createHash('sha256')
    .update(inProgressBody)
    .digest('hex');
  return `github-summary:${commentId}:body:${bodyFingerprint}`;
}

/**
 * Classifies a non-mention PR review webhook event into a review-activity
 * notification input for the owning task's originating conversation (Slack,
 * Teams, or Telegram), or returns `null` when the event should not notify
 * anyone:
 *
 * - `@roomote` mentions are excluded because the mention flow already
 *   handles them (and replies on the PR itself).
 * - Empty `commented` review submissions are excluded because they are the
 *   synthetic wrappers GitHub creates around individual inline comments; the
 *   matching `pull_request_review_comment.created` events carry the signal.
 * - Roomote-authored replies to existing review threads are excluded so a
 *   task answering review feedback does not notify about its own replies.
 *   Roomote-authored new threads (e.g. findings from a Roomote PR review)
 *   still notify.
 */
export function buildPrReviewActivityNotificationInput(
  eventPayload: PrReviewActivityWebhookPayload,
  context: GitHubWebhookContext = {},
): EnqueuePrReviewNotificationInput | null {
  const author =
    'issue' in eventPayload
      ? eventPayload.comment.user
      : 'review' in eventPayload
        ? eventPayload.review.user
        : eventPayload.comment.user;

  if (isExternalBotAuthor(author)) {
    return null;
  }

  if ('issue' in eventPayload) {
    if (!eventPayload.issue.pull_request) {
      return null;
    }

    const comment = eventPayload.comment;

    const revision = getIssueCommentRevision(eventPayload, context);
    const authorLogin = comment.user?.login;
    const body = getReviewBody(comment.body);

    if (
      !authorLogin ||
      GitHubSchemas.isManagedRoomoteGitHubLogin(authorLogin) ||
      isMention({ body: comment.body ?? '', user: { login: authorLogin } })
    ) {
      return null;
    }

    return {
      repository: eventPayload.repository.full_name,
      prNumber: eventPayload.issue.number,
      prUrl:
        eventPayload.issue.pull_request.html_url ?? eventPayload.issue.html_url,
      sourceControlProvider: 'github',
      event: {
        kind: 'issue_comment',
        providerEventId: `github-issue-comment:${comment.id}:${revision}`,
        authorLogin,
        ...getAutomatedAuthorMetadata(comment.user),
        ...(body ? { body } : {}),
        ...(comment.html_url ? { url: comment.html_url } : {}),
        observedAt: getObservedAt(comment.updated_at ?? comment.created_at),
      },
    };
  }

  const base = {
    repository: eventPayload.repository.full_name,
    prNumber: eventPayload.pull_request.number,
    prUrl: eventPayload.pull_request.html_url,
    sourceControlProvider: 'github' as const,
  };

  if ('review' in eventPayload) {
    const review = eventPayload.review;
    const authorLogin = review.user?.login;
    const body = getReviewBody(review.body);

    if (!authorLogin) {
      return null;
    }

    if (isMention({ body: review.body ?? '', user: { login: authorLogin } })) {
      return null;
    }

    if (review.state === 'commented' && !review.body) {
      return null;
    }

    return {
      ...base,
      event: {
        kind: 'review',
        providerEventId: `github-review:${review.id}`,
        authorLogin,
        ...getAutomatedAuthorMetadata(review.user),
        ...(body ? { body } : {}),
        ...(review.commit_id ? { reviewHeadSha: review.commit_id } : {}),
        batchId: `github-review:${review.id}`,
        reviewState: review.state,
        ...(review.html_url ? { url: review.html_url } : {}),
        ...(review.submitted_at
          ? { observedAt: getObservedAt(review.submitted_at) }
          : {}),
        ...(GitHubSchemas.isManagedRoomoteGitHubLogin(authorLogin)
          ? { roomoteAuthored: true }
          : {}),
      },
    };
  }

  const comment = eventPayload.comment;
  const authorLogin = comment.user?.login;
  const body = getReviewBody(comment.body);

  if (!authorLogin) {
    return null;
  }

  if (isMention({ body: comment.body ?? '', user: { login: authorLogin } })) {
    return null;
  }

  if (
    comment.in_reply_to_id &&
    GitHubSchemas.isManagedRoomoteGitHubLogin(authorLogin)
  ) {
    return null;
  }

  return {
    ...base,
    event: {
      kind: 'review_comment',
      providerEventId: `github-review-comment:${comment.id}`,
      authorLogin,
      ...getAutomatedAuthorMetadata(comment.user),
      ...(comment.in_reply_to_id
        ? { inReplyToId: String(comment.in_reply_to_id) }
        : {}),
      ...(body ? { body } : {}),
      ...(comment.commit_id ? { reviewHeadSha: comment.commit_id } : {}),
      ...(comment.pull_request_review_id
        ? { batchId: `github-review:${comment.pull_request_review_id}` }
        : {}),
      ...(comment.html_url ? { url: comment.html_url } : {}),
      observedAt: getObservedAt(comment.created_at),
      ...(GitHubSchemas.isManagedRoomoteGitHubLogin(authorLogin)
        ? { roomoteAuthored: true }
        : {}),
    },
  };
}

/**
 * Extracts a short plain-text summary line from a Roomote review-summary
 * comment's status section: Markdown links become their labels, bold markers
 * are stripped, and whitespace collapses to a single line.
 */
function sanitizeReviewSummaryStatus(statusContent: string): string {
  return statusContent
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:[—–-]\s*)?see task\.?\s*$/i, '')
    .trim()
    .slice(0, MAX_SUMMARY_LENGTH);
}

/**
 * Parses the head SHA out of the review-summary marker line, e.g.
 * `<!-- roomote-review-summary sha=abc123 mode=initial -->`.
 */
function getReviewSummaryMarkerSha(body: string): string | null {
  const match = body.match(/<!--\s*roomote-review-summary\s+sha=([0-9a-f]+)/i);

  return match?.[1] ?? null;
}

function getReviewSummaryMarkerMode(body: string): 'initial' | 'sync' | null {
  const mode = body.match(
    /<!--\s*roomote-review-summary\s+[^>]*mode=(initial|sync)\b/i,
  )?.[1];
  return mode === 'initial' || mode === 'sync' ? mode : null;
}

function getReviewFindingCount(body: string, summary: string): number | null {
  const uncheckedCount = body.match(/^- \[ \] /gm)?.length ?? 0;
  if (uncheckedCount > 0) {
    return uncheckedCount;
  }

  const statedCount = summary.match(/\b(\d+)\s+issues?\s+outstanding\b/i)?.[1];
  return statedCount === undefined ? null : Number.parseInt(statedCount, 10);
}

function getReviewOutcome(
  summary: string,
  findingCount: number | null,
): string | null {
  if ((findingCount ?? 0) > 0) {
    return 'findings_remain';
  }
  if (
    /\bno (?:code|new) issues? found\b/i.test(summary) ||
    /\ball \d+ issues? addressed\b/i.test(summary)
  ) {
    return 'clean';
  }
  return null;
}

function getReviewApprovalStatus(
  summary: string,
): 'approved' | 'skipped' | null {
  if (/\bapproval\s+skipped\b/i.test(summary)) {
    return 'skipped';
  }
  return /\bapproved\b/i.test(summary) ? 'approved' : null;
}

type PrReviewSummaryNotification = {
  input: EnqueuePrReviewNotificationInput;
};

type PrReviewSummaryLifecycle =
  | { kind: 'started'; input: StartPrReviewNotificationCycleInput }
  | { kind: 'completed'; notification: PrReviewSummaryNotification };

function getReviewStatusFirstLine(body: string): string | null {
  const statusContent = getMarkedSection({
    content: body,
    startMarker: REVIEW_STATUS_START_MARKER,
    endMarker: REVIEW_STATUS_END_MARKER,
  });

  if (!statusContent) {
    return null;
  }

  return statusContent.split('\n')[0] ?? '';
}

/**
 * Classifies a PR issue-comment webhook event (created or edited) into a
 * review-summary notification when the comment is a Roomote review-summary
 * comment whose status section is terminal.
 *
 * Roomote posts the summary comment in "review in progress" form first and
 * patches it with the results, so real review completions usually arrive via
 * `issue_comment.edited`. For edited events, only notify when the status
 * transitions from an in-progress review line to a terminal result (the review
 * workflow's signature move). Terminal → terminal rewrites — for example a PR
 * fixer checking off checklist items or rewriting status to "all addressed" —
 * must not enqueue another self-review notice. Edited events without a
 * previous body (`changes.body.from`) are suppressed as unverifiable. Created
 * events with an already-terminal body still notify so legacy/crash paths that
 * post a terminal summary directly keep working.
 */
function buildPrReviewSummaryLifecycle(
  eventPayload: PrReviewSummaryWebhookPayload,
  context: GitHubWebhookContext = {},
): PrReviewSummaryLifecycle | null {
  if (!eventPayload.issue.pull_request) {
    return null;
  }

  const comment = eventPayload.comment;
  const authorLogin = comment.user?.login;

  if (!authorLogin || !GitHubSchemas.isManagedRoomoteGitHubLogin(authorLogin)) {
    return null;
  }

  const body = comment.body ?? '';

  if (!body.trimStart().startsWith(REVIEW_SUMMARY_MARKER)) {
    return null;
  }

  const statusContent = getMarkedSection({
    content: body,
    startMarker: REVIEW_STATUS_START_MARKER,
    endMarker: REVIEW_STATUS_END_MARKER,
  });

  if (!statusContent) {
    return null;
  }

  const firstStatusLine = statusContent.split('\n')[0] ?? '';
  const currentInProgress = isReviewInProgressStatusLine(firstStatusLine);
  const previousBody =
    'changes' in eventPayload ? eventPayload.changes.body?.from : undefined;
  const previousStatusLine =
    typeof previousBody === 'string'
      ? getReviewStatusFirstLine(previousBody)
      : null;
  const previousInProgress =
    previousStatusLine !== null &&
    isReviewInProgressStatusLine(previousStatusLine);
  const markerSha = getReviewSummaryMarkerSha(body);
  const reviewTaskId = getReviewTaskId(body);
  const revision = getIssueCommentRevision(eventPayload, context);
  const observedAt = getObservedAt(comment.updated_at ?? comment.created_at);

  if (currentInProgress) {
    if (!markerSha || previousInProgress) {
      return null;
    }

    return {
      kind: 'started',
      input: {
        repository: eventPayload.repository.full_name,
        prNumber: eventPayload.issue.number,
        reviewHeadSha: markerSha,
        cycleId: comment.updated_at
          ? `github-summary:${comment.id}:${revision}`
          : getTimestampLessSummaryCycleId(comment.id, body),
        observedAt,
      },
    };
  }

  // Edited events: require an in-progress → terminal status transition so
  // bookkeeping edits of an already-finished summary do not look like a new
  // review pass. `changes` is only present on issue_comment.edited payloads.
  if ('changes' in eventPayload) {
    if (typeof previousBody !== 'string') {
      return null;
    }

    if (!previousInProgress) {
      return null;
    }
  }

  const summary = sanitizeReviewSummaryStatus(statusContent);

  if (!summary) {
    return null;
  }
  const findingCount = getReviewFindingCount(body, summary);

  return {
    kind: 'completed',
    notification: {
      input: {
        repository: eventPayload.repository.full_name,
        prNumber: eventPayload.issue.number,
        prUrl:
          eventPayload.issue.pull_request.html_url ??
          eventPayload.issue.html_url,
        sourceControlProvider: 'github',
        event: {
          kind: 'review_summary',
          providerEventId: `github-review-summary:${comment.id}:${revision}`,
          authorLogin,
          ...(markerSha ? { reviewHeadSha: markerSha } : {}),
          ...(reviewTaskId ? { reviewTaskId } : {}),
          reviewResult: {
            reviewKind: getReviewSummaryMarkerMode(body),
            outcome: getReviewOutcome(summary, findingCount),
            findingCount,
            approvalStatus: getReviewApprovalStatus(summary),
            headSha: markerSha,
          },
          ...(!comment.updated_at && typeof previousBody === 'string'
            ? {
                batchId: getTimestampLessSummaryCycleId(
                  comment.id,
                  previousBody,
                ),
              }
            : {}),
          summary,
          ...(comment.html_url ? { url: comment.html_url } : {}),
          observedAt,
          roomoteAuthored: true,
        },
      },
    },
  };
}

export function buildPrReviewSummaryNotification(
  eventPayload: PrReviewSummaryWebhookPayload,
  context: GitHubWebhookContext = {},
): PrReviewSummaryNotification | null {
  const lifecycle = buildPrReviewSummaryLifecycle(eventPayload, context);

  return lifecycle?.kind === 'completed' ? lifecycle.notification : null;
}

/**
 * Persists Roomote review-summary lifecycle state for task-linked pull
 * requests. Failures propagate so the webhook delivery can be retried.
 */
export async function queuePrReviewSummaryNotification(
  eventPayload: PrReviewSummaryWebhookPayload,
  deliveryId?: string,
): Promise<void> {
  const lifecycle = buildPrReviewSummaryLifecycle(eventPayload, { deliveryId });

  if (!lifecycle) {
    return;
  }

  const reference =
    lifecycle.kind === 'started'
      ? lifecycle.input
      : lifecycle.notification.input;

  try {
    if (lifecycle.kind === 'started') {
      await startPrReviewNotificationCycle(lifecycle.input);
      return;
    }

    const { event } = lifecycle.notification.input;
    const operations: Promise<unknown>[] = [
      enqueuePrReviewNotification(lifecycle.notification.input),
    ];
    if (
      eventPayload.installation?.id &&
      event.reviewTaskId &&
      event.reviewHeadSha
    ) {
      operations.push(
        completeGithubPrReviewCheckFromSummary({
          installationId: eventPayload.installation.id,
          repository: lifecycle.notification.input.repository,
          prNumber: lifecycle.notification.input.prNumber,
          taskId: event.reviewTaskId,
          reviewHeadSha: event.reviewHeadSha,
          reviewSummaryBody: eventPayload.comment.body ?? '',
        }),
      );
    }
    await Promise.all(operations);
  } catch (error) {
    console.warn(
      `[queuePrReviewSummaryNotification] Failed to record review-summary lifecycle for ${reference.repository}#${reference.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

/**
 * Persists PR review activity for task-linked pull requests. Failures
 * propagate so the webhook delivery can be retried.
 */
export async function queuePrReviewActivityNotification(
  eventPayload: PrReviewActivityWebhookPayload,
  deliveryId?: string,
): Promise<void> {
  const input = buildPrReviewActivityNotificationInput(eventPayload, {
    deliveryId,
  });

  if (!input) {
    return;
  }

  await enqueuePrReviewNotification(input).catch((error) => {
    console.warn(
      `[queuePrReviewActivityNotification] Failed to persist review notification for ${input.repository}#${input.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  });
}
