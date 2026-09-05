import {
  isTaskExecutingTurn,
  parsePrReviewActionOffer,
  parseSessionPrReviewUpdate,
  type PrReviewActionOffer,
  type SessionPrReviewUpdate,
} from '@roomote/types';
import type { SessionReviewTask } from './session-task-panel-context';

export interface SessionReview {
  key: string;
  revision: string;
  review: SessionPrReviewUpdate | null;
  offer: PrReviewActionOffer | null;
  reviewTaskId?: string;
  reviewing?: boolean;
}

export function getSessionPrReviews(
  messages: Array<{ id: string; payload: Record<string, unknown> | null }>,
  tasks: SessionReviewTask[],
): SessionReview[] {
  const reviews = new Map<string, SessionReview>();
  // Messages are in transcript order. Keep the latest update, including
  // dismissals, so an older pending action cannot reappear underneath it.
  for (const message of messages) {
    const review = parseSessionPrReviewUpdate(message.payload);
    const offer = parsePrReviewActionOffer(message.payload);
    if (!review && !offer) continue;
    const key = review?.url ?? offer!.deliveryId;
    reviews.set(key, {
      key,
      revision: message.id,
      review,
      offer,
      reviewTaskId: review?.reviewTaskId,
    });
  }

  for (const task of tasks) {
    const reviewing = isTaskExecutingTurn(
      task.latestRun?.status,
      task.latestRun?.taskPhase,
    );
    for (const pr of task.pullRequests) {
      const current = reviews.get(pr.url);
      if (pr.status === 'merged' || pr.status === 'closed') {
        if (current?.review) {
          reviews.set(pr.url, {
            ...current,
            review: { ...current.review, status: pr.status },
            offer: null,
            reviewing: false,
          });
        }
        continue;
      }
      if (
        task.workflow !== 'pr_review' ||
        current?.review?.status === 'merged' ||
        current?.review?.status === 'closed'
      )
        continue;
      // A live review takes precedence over completed review tasks for this PR.
      if (current?.reviewing) continue;
      if (current) {
        reviews.set(pr.url, {
          ...current,
          reviewTaskId: reviewing
            ? task.taskId
            : (current.reviewTaskId ?? task.taskId),
          reviewing,
        });
      } else if (reviewing && pr.number !== null) {
        reviews.set(pr.url, {
          key: pr.url,
          revision: task.taskId,
          reviewTaskId: task.taskId,
          reviewing: true,
          offer: null,
          review: {
            url: pr.url,
            repository: pr.repository ?? '',
            number: pr.number,
            summary: '',
            findingCount: null,
            status: 'feedback',
          },
        });
      }
    }
  }
  return [...reviews.values()].filter(
    ({ offer, reviewing, review }) =>
      reviewing ||
      (offer?.status !== 'dismissed' && offer?.status !== 'stale') ||
      (review && review.status !== 'feedback'),
  );
}
