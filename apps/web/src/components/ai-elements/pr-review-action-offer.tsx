import { useEffect, useState } from 'react';
import {
  PR_REVIEW_ACTION_LABELS,
  type PrReviewActionChoice,
  type PrReviewActionOffer as PrReviewActionOfferData,
  type PrReviewActionOfferStatus,
} from '@roomote/types';

import { Button } from '@/components/system';

const STATUS_TEXT: Record<
  Exclude<PrReviewActionOfferStatus, 'pending'>,
  string
> = {
  resolved: 'Resolving the current review issues.',
  auto_resolved: 'Auto-resolve is enabled for this pull request.',
  dismissed: 'Review action dismissed.',
  stale: 'This offer was already handled or has expired.',
};

export function PrReviewActionOffer({
  offer,
  onAction,
}: {
  offer: PrReviewActionOfferData;
  onAction: (
    choice: PrReviewActionChoice,
  ) => Promise<PrReviewActionOfferStatus>;
}) {
  const [status, setStatus] = useState(offer.status);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => setStatus(offer.status), [offer.status]);

  if (status !== 'pending') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {STATUS_TEXT[status]}
      </p>
    );
  }

  const submit = async (choice: PrReviewActionChoice) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      setStatus(await onAction(choice));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2" aria-label={offer.question}>
      <Button size="sm" disabled={isSubmitting} onClick={() => submit('yes')}>
        {PR_REVIEW_ACTION_LABELS.yes}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={isSubmitting}
        onClick={() => submit('auto')}
      >
        {PR_REVIEW_ACTION_LABELS.auto}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={isSubmitting}
        onClick={() => submit('dismiss')}
      >
        {PR_REVIEW_ACTION_LABELS.dismiss}
      </Button>
    </div>
  );
}
