'use client';

import { useState } from 'react';
import removeMd from 'remove-markdown';
import type {
  PrReviewActionChoice,
  PrReviewActionOfferStatus,
} from '@roomote/types';
import {
  Button,
  BasicTooltip,
  ChevronDown,
  GitPullRequest,
  X,
} from '@/components/system';
import { PrReviewActionOffer } from '@/components/ai-elements/pr-review-action-offer';
import { useOpenSessionTaskPanel } from './session-task-panel-context';
import type { SessionReview } from './session-pr-reviews';

function ReviewRow({
  item,
  onAction,
  expanded,
  onToggle,
}: {
  item: SessionReview;
  expanded: boolean;
  onToggle?: () => void;
  onAction: (
    deliveryId: string,
    choice: PrReviewActionChoice,
  ) => Promise<PrReviewActionOfferStatus>;
}) {
  const openTask = useOpenSessionTaskPanel();
  const [dismissed, setDismissed] = useState(false);
  const [actionStatus, setActionStatus] =
    useState<PrReviewActionOfferStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { review, offer, reviewing } = item;
  const status = actionStatus ?? offer?.status;
  const terminal =
    review?.status === 'approved' ||
    review?.status === 'merged' ||
    review?.status === 'closed';
  if (
    dismissed ||
    (!reviewing && !terminal && (status === 'dismissed' || status === 'stale'))
  )
    return null;
  const acting = status === 'resolved' || status === 'auto_resolved';
  const label = reviewing
    ? 'Reviewing…'
    : terminal
      ? {
          approved: 'Approved',
          merged: 'Merged',
          closed: 'Closed',
          feedback: '',
        }[review.status]
      : status === 'auto_resolved'
        ? 'Auto-resolve enabled'
        : acting
          ? 'Addressing findings…'
          : review?.findingCount != null && review.findingCount > 0
            ? `${review.findingCount} unresolved ${review.findingCount === 1 ? 'finding' : 'findings'}`
            : 'Review feedback';

  return (
    <section
      aria-label={
        review
          ? `Review of ${review.repository} PR #${review.number}`
          : 'PR review'
      }
      className="min-w-0 px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
        <BasicTooltip content={review?.repository || 'Pull request review'}>
          <span className="shrink-0 font-medium">
            {review ? `PR #${review.number}` : 'PR review'}
          </span>
        </BasicTooltip>
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          role="status"
        >
          {label}
        </span>
        {item.reviewTaskId && openTask ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openTask(item.reviewTaskId!)}
          >
            View review
          </Button>
        ) : review ? (
          <Button size="sm" variant="ghost" asChild>
            <a href={review.url} target="_blank" rel="noopener noreferrer">
              View review
            </a>
          </Button>
        ) : null}
        {terminal ? (
          <BasicTooltip content="Dismiss review">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Dismiss review"
              onClick={() => setDismissed(true)}
            >
              <X />
            </Button>
          </BasicTooltip>
        ) : null}
        {onToggle && !terminal && !reviewing && !acting ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Review details for ${review ? `PR #${review.number}` : 'pull request'}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <ChevronDown className={expanded ? 'rotate-180' : undefined} />
          </Button>
        ) : null}
      </div>
      {expanded && !reviewing && !terminal && !acting && review?.summary ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {removeMd(review.summary)}
        </p>
      ) : null}
      {expanded && !reviewing && !terminal && !acting && offer ? (
        <PrReviewActionOffer
          className="mt-2"
          labels={{
            yes: review?.findingCount === 1 ? 'Fix finding' : 'Fix findings',
            auto: 'Auto-resolve',
            dismiss: 'Dismiss',
          }}
          offer={offer}
          onAction={async (choice) => {
            setError(null);
            try {
              const nextStatus = await onAction(offer.deliveryId, choice);
              setActionStatus(nextStatus);
              return nextStatus;
            } catch {
              setError('Could not update this review. Please try again.');
              return status ?? offer.status;
            }
          }}
        />
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function SessionPrReviewStrip({
  reviews,
  onAction,
}: {
  reviews: SessionReview[];
  onAction: (
    deliveryId: string,
    choice: PrReviewActionChoice,
  ) => Promise<PrReviewActionOfferStatus>;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null | undefined>(
    undefined,
  );
  const selectedKey =
    expandedKey === undefined ||
    (expandedKey !== null && !reviews.some((item) => item.key === expandedKey))
      ? reviews.at(-1)?.key
      : expandedKey;
  if (reviews.length === 0) return null;
  return (
    <div
      aria-label="Pull request reviews"
      className="max-h-52 shrink-0 overflow-y-auto border-t border-border/60 bg-card divide-y divide-border/60"
    >
      {reviews.map((item) => (
        <ReviewRow
          key={`${item.key}:${item.revision}:${item.offer?.status ?? ''}:${item.review?.status ?? ''}:${item.reviewing ?? false}`}
          item={item}
          expanded={reviews.length === 1 || selectedKey === item.key}
          onToggle={
            reviews.length > 1
              ? () => setExpandedKey(selectedKey === item.key ? null : item.key)
              : undefined
          }
          onAction={onAction}
        />
      ))}
    </div>
  );
}
