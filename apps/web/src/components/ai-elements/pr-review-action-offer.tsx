import { useEffect, useState } from 'react';
import {
  PR_REVIEW_ACTION_LABELS,
  type PrReviewActionChoice,
  type PrReviewActionOffer as PrReviewActionOfferData,
  type PrReviewActionOfferStatus,
} from '@roomote/types';

import { Button } from '@/components/system';
import { cn } from '@/lib/utils';

const STATUS_TEXT: Record<
  Exclude<PrReviewActionOfferStatus, 'pending' | 'dismissed'>,
  string
> = {
  resolved: 'Resolving the current review issues.',
  auto_resolved: 'Auto-resolve is enabled for this pull request.',
  stale: 'This offer was already handled or has expired.',
};

export function PrReviewActionOffer({
  offer,
  onAction,
  className,
  showQuestion = false,
  testId = 'pr-review-action-offer',
  labels = PR_REVIEW_ACTION_LABELS,
}: {
  offer: PrReviewActionOfferData;
  onAction: (
    choice: PrReviewActionChoice,
  ) => Promise<PrReviewActionOfferStatus>;
  className?: string;
  showQuestion?: boolean;
  testId?: string;
  labels?: Record<PrReviewActionChoice, string>;
}) {
  const [status, setStatus] = useState(offer.status);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => setStatus(offer.status), [offer.status]);

  const submit = async (choice: PrReviewActionChoice) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      setStatus(await onAction(choice));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === 'dismissed') return null;

  return (
    <div className={cn(className)} data-testid={testId}>
      {showQuestion ? <p className="mb-2 text-sm">{offer.question}</p> : null}
      {status === 'pending' ? (
        <div className="flex flex-wrap gap-2" aria-label={offer.question}>
          <Button
            size="sm"
            disabled={isSubmitting}
            onClick={() => submit('yes')}
          >
            {labels.yes}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={isSubmitting}
            onClick={() => submit('auto')}
          >
            {labels.auto}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => submit('dismiss')}
          >
            {labels.dismiss}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          {STATUS_TEXT[status]}
        </p>
      )}
    </div>
  );
}
