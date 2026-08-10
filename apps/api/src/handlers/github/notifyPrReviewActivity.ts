import {
  REVIEW_STATUS_END_MARKER,
  REVIEW_STATUS_START_MARKER,
  REVIEW_SUMMARY_MARKER,
  getMarkedSection,
  isReviewInProgressStatusLine,
} from '@roomote/cloud-agents/server';
import { Schemas as GitHubSchemas } from '@roomote/github';
import { getRedis } from '@roomote/redis';
import {
  enqueuePrReviewNotification,
  getPrReviewCompletedMarkerKey,
  type EnqueuePrReviewNotificationInput,
} from '@roomote/sdk/server';

import { isMention } from './isMention';
import type {
  WebhookIssueCommentCreated,
  WebhookIssueCommentEdited,
  WebhookPullRequestCommentCreated,
  WebhookPullRequestReviewSubmitted,
} from './types';

type PrReviewActivityWebhookPayload =
  | WebhookPullRequestReviewSubmitted
  | WebhookPullRequestCommentCreated;

type PrReviewSummaryWebhookPayload =
  | WebhookIssueCommentCreated
  | WebhookIssueCommentEdited;

const SUMMARY_NOTIFIED_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SUMMARY_LENGTH = 300;
const DELETE_IF_VALUE_MATCHES_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

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
        authorLogin,
        ...(review.commit_id ? { reviewHeadSha: review.commit_id } : {}),
        reviewState: review.state,
        ...(review.html_url ? { url: review.html_url } : {}),
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
      authorLogin,
      ...(comment.commit_id ? { reviewHeadSha: comment.commit_id } : {}),
      ...(comment.html_url ? { url: comment.html_url } : {}),
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
  /** Deduplication key so repeated edits of the same terminal summary (for
   * example a PR fixer checking off items) only notify once per review pass. */
  dedupKey: string;
};

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
export function buildPrReviewSummaryNotification(
  eventPayload: PrReviewSummaryWebhookPayload,
): PrReviewSummaryNotification | null {
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

  if (isReviewInProgressStatusLine(firstStatusLine)) {
    return null;
  }

  // Edited events: require an in-progress → terminal status transition so
  // bookkeeping edits of an already-finished summary do not look like a new
  // review pass. `changes` is only present on issue_comment.edited payloads.
  if ('changes' in eventPayload) {
    const previousBody = eventPayload.changes.body?.from;

    if (typeof previousBody !== 'string') {
      return null;
    }

    const previousStatusLine = getReviewStatusFirstLine(previousBody);

    if (
      previousStatusLine === null ||
      !isReviewInProgressStatusLine(previousStatusLine)
    ) {
      return null;
    }
  }

  const summary = sanitizeReviewSummaryStatus(statusContent);

  if (!summary) {
    return null;
  }

  const markerSha = getReviewSummaryMarkerSha(body);

  return {
    input: {
      repository: eventPayload.repository.full_name,
      prNumber: eventPayload.issue.number,
      prUrl:
        eventPayload.issue.pull_request.html_url ?? eventPayload.issue.html_url,
      sourceControlProvider: 'github',
      event: {
        kind: 'review_summary',
        authorLogin,
        ...(markerSha ? { reviewHeadSha: markerSha } : {}),
        summary,
        ...(comment.html_url ? { url: comment.html_url } : {}),
        roomoteAuthored: true,
      },
    },
    dedupKey: `pr-review-notification:summary-notified:${encodeURIComponent(
      eventPayload.repository.full_name,
    )}#${eventPayload.issue.number}:${comment.id}:${markerSha ?? 'no-sha'}`,
  };
}

async function enqueuePrReviewSummaryNotificationOnce(
  notification: PrReviewSummaryNotification,
): Promise<void> {
  const redis = getRedis();
  const reviewHeadSha = notification.input.event.reviewHeadSha;
  const completedReviewKey = reviewHeadSha
    ? getPrReviewCompletedMarkerKey({
        repository: notification.input.repository,
        prNumber: notification.input.prNumber,
        reviewHeadSha,
      })
    : null;
  const claim = await redis.set(
    notification.dedupKey,
    '1',
    'EX',
    SUMMARY_NOTIFIED_TTL_SECONDS,
    'NX',
  );

  if (claim !== 'OK') {
    return;
  }

  // Keep the claim only when something was actually scheduled. Releasing it
  // on no-op results (PR not linked to a conversation-backed task yet) or on
  // errors lets a later created/edited delivery of the same terminal summary
  // retry instead of being suppressed for the TTL.
  try {
    if (completedReviewKey) {
      await redis.set(
        completedReviewKey,
        notification.dedupKey,
        'EX',
        SUMMARY_NOTIFIED_TTL_SECONDS,
      );
    }

    const result = await enqueuePrReviewNotification(notification.input);

    if (result.notifiedTaskCount === 0) {
      await redis.del(notification.dedupKey).catch(() => undefined);
      if (completedReviewKey) {
        await redis
          .eval(
            DELETE_IF_VALUE_MATCHES_SCRIPT,
            1,
            completedReviewKey,
            notification.dedupKey,
          )
          .catch(() => undefined);
      }
      return;
    }
  } catch (error) {
    await redis.del(notification.dedupKey).catch(() => undefined);
    if (completedReviewKey) {
      await redis
        .eval(
          DELETE_IF_VALUE_MATCHES_SCRIPT,
          1,
          completedReviewKey,
          notification.dedupKey,
        )
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Fire-and-forget notification scheduling for Roomote review-summary comments
 * on task-linked pull requests. Logs errors but never throws.
 */
export function queuePrReviewSummaryNotification(
  eventPayload: PrReviewSummaryWebhookPayload,
): void {
  const notification = buildPrReviewSummaryNotification(eventPayload);

  if (!notification) {
    return;
  }

  enqueuePrReviewSummaryNotificationOnce(notification).catch((error) =>
    console.warn(
      `[queuePrReviewSummaryNotification] Failed to enqueue review-summary notification for ${notification.input.repository}#${notification.input.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
}

/**
 * Fire-and-forget notification scheduling for PR review activity on
 * task-linked pull requests. Logs errors but never throws, so it cannot
 * affect the mention-handling webhook flow.
 */
export function queuePrReviewActivityNotification(
  eventPayload: PrReviewActivityWebhookPayload,
): void {
  const input = buildPrReviewActivityNotificationInput(eventPayload);

  if (!input) {
    return;
  }

  enqueuePrReviewActivityNotification(input).catch((error) =>
    console.warn(
      `[queuePrReviewActivityNotification] Failed to enqueue review notification for ${input.repository}#${input.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
}

async function enqueuePrReviewActivityNotification(
  input: EnqueuePrReviewNotificationInput,
): Promise<void> {
  if (input.event.roomoteAuthored && input.event.reviewHeadSha) {
    const completed = await getRedis().get(
      getPrReviewCompletedMarkerKey({
        repository: input.repository,
        prNumber: input.prNumber,
        reviewHeadSha: input.event.reviewHeadSha,
      }),
    );

    if (completed) {
      return;
    }
  }

  await enqueuePrReviewNotification(input);
}
