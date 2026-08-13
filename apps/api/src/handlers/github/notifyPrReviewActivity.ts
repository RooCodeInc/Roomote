import {
  REVIEW_STATUS_END_MARKER,
  REVIEW_STATUS_START_MARKER,
  REVIEW_SUMMARY_MARKER,
  getMarkedSection,
  isReviewInProgressStatusLine,
} from '@roomote/cloud-agents/server';
import { Schemas as GitHubSchemas } from '@roomote/github';
import {
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
  | WebhookPullRequestReviewSubmitted
  | WebhookPullRequestCommentCreated;

type PrReviewSummaryWebhookPayload =
  | WebhookIssueCommentCreated
  | WebhookIssueCommentEdited;

const MAX_SUMMARY_LENGTH = 300;

function getObservedAt(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : Date.now();
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
): EnqueuePrReviewNotificationInput | null {
  if ('issue' in eventPayload) {
    if (!eventPayload.issue.pull_request) {
      return null;
    }

    const comment = eventPayload.comment;
    const authorLogin = comment.user?.login;

    if (
      !authorLogin ||
      GitHubSchemas.isRoomoteGitHubLogin(authorLogin) ||
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
        providerEventId: `github-issue-comment:${comment.id}`,
        authorLogin,
        ...(comment.html_url ? { url: comment.html_url } : {}),
        observedAt: getObservedAt(comment.created_at),
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
        ...(review.commit_id ? { reviewHeadSha: review.commit_id } : {}),
        batchId: `github-review:${review.id}`,
        reviewState: review.state,
        ...(review.html_url ? { url: review.html_url } : {}),
        ...(review.submitted_at
          ? { observedAt: getObservedAt(review.submitted_at) }
          : {}),
        ...(GitHubSchemas.isRoomoteGitHubLogin(authorLogin)
          ? { roomoteAuthored: true }
          : {}),
      },
    };
  }

  const comment = eventPayload.comment;
  const authorLogin = comment.user?.login;

  if (!authorLogin) {
    return null;
  }

  if (isMention({ body: comment.body ?? '', user: { login: authorLogin } })) {
    return null;
  }

  if (
    comment.in_reply_to_id &&
    GitHubSchemas.isRoomoteGitHubLogin(authorLogin)
  ) {
    return null;
  }

  return {
    ...base,
    event: {
      kind: 'review_comment',
      providerEventId: `github-review-comment:${comment.id}`,
      authorLogin,
      ...(comment.commit_id ? { reviewHeadSha: comment.commit_id } : {}),
      ...(comment.pull_request_review_id
        ? { batchId: `github-review:${comment.pull_request_review_id}` }
        : {}),
      ...(comment.html_url ? { url: comment.html_url } : {}),
      observedAt: getObservedAt(comment.created_at),
      ...(GitHubSchemas.isRoomoteGitHubLogin(authorLogin)
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
): PrReviewSummaryLifecycle | null {
  if (!eventPayload.issue.pull_request) {
    return null;
  }

  const comment = eventPayload.comment;
  const authorLogin = comment.user?.login;

  if (!authorLogin || !GitHubSchemas.isRoomoteGitHubLogin(authorLogin)) {
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
        cycleId: `github-summary:${comment.id}:${comment.updated_at ?? comment.created_at}`,
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
          providerEventId: `github-review-summary:${comment.id}:${comment.updated_at ?? comment.created_at}`,
          authorLogin,
          ...(markerSha ? { reviewHeadSha: markerSha } : {}),
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
): PrReviewSummaryNotification | null {
  const lifecycle = buildPrReviewSummaryLifecycle(eventPayload);

  return lifecycle?.kind === 'completed' ? lifecycle.notification : null;
}

/**
 * Persists Roomote review-summary lifecycle state for task-linked pull
 * requests. Failures propagate so the webhook delivery can be retried.
 */
export async function queuePrReviewSummaryNotification(
  eventPayload: PrReviewSummaryWebhookPayload,
): Promise<void> {
  const lifecycle = buildPrReviewSummaryLifecycle(eventPayload);

  if (!lifecycle) {
    return;
  }

  const operation =
    lifecycle.kind === 'started'
      ? startPrReviewNotificationCycle(lifecycle.input)
      : enqueuePrReviewNotification(lifecycle.notification.input);
  const reference =
    lifecycle.kind === 'started'
      ? lifecycle.input
      : lifecycle.notification.input;

  await operation.catch((error) => {
    console.warn(
      `[queuePrReviewSummaryNotification] Failed to record review-summary lifecycle for ${reference.repository}#${reference.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  });
}

/**
 * Persists PR review activity for task-linked pull requests. Failures
 * propagate so the webhook delivery can be retried.
 */
export async function queuePrReviewActivityNotification(
  eventPayload: PrReviewActivityWebhookPayload,
): Promise<void> {
  const input = buildPrReviewActivityNotificationInput(eventPayload);

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
