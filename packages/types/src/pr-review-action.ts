/**
 * Callback-data encoding for PR review-feedback notification buttons on
 * providers with opaque button payloads (Discord custom_id <= 100 chars,
 * Telegram callback_data <= 64 bytes): "prr:<choice-letter>:<nonce>".
 * Kept dependency-free so webhook dispatchers can parse without loading
 * server-side modules.
 */
export type PrReviewActionChoice = 'yes' | 'auto' | 'dismiss';

export const PR_REVIEW_ACTION_LABELS: Record<PrReviewActionChoice, string> = {
  yes: 'Resolve these issues',
  auto: 'Auto-resolve on this PR',
  dismiss: 'Dismiss',
};

export const PR_REVIEW_ACTION_OFFER_PAYLOAD_KEY = 'prReviewAction' as const;

export type PrReviewActionOfferStatus =
  | 'pending'
  | 'resolved'
  | 'auto_resolved'
  | 'dismissed'
  | 'stale';

export interface PrReviewActionOffer {
  deliveryId: string;
  question: string;
  status: PrReviewActionOfferStatus;
}

/** Canonical PR context for session review updates, independent of action offers. */
export interface SessionPrReviewUpdate {
  reviewTaskId?: string;
  url: string;
  repository: string;
  number: number;
  summary: string;
  findingCount: number | null;
  status: 'feedback' | 'approved' | 'merged' | 'closed';
}

export function parseSessionPrReviewUpdate(
  payload: Record<string, unknown> | null | undefined,
): SessionPrReviewUpdate | null {
  const value = payload?.prReview;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const review = value as Record<string, unknown>;
  if (
    typeof review.url !== 'string' ||
    !/^https?:\/\//i.test(review.url) ||
    typeof review.repository !== 'string' ||
    !Number.isInteger(review.number) ||
    Number(review.number) <= 0 ||
    typeof review.summary !== 'string' ||
    (review.reviewTaskId !== undefined &&
      typeof review.reviewTaskId !== 'string') ||
    !(
      review.findingCount === null ||
      (Number.isInteger(review.findingCount) &&
        Number(review.findingCount) >= 0)
    ) ||
    !['feedback', 'approved', 'merged', 'closed'].includes(
      String(review.status),
    )
  )
    return null;
  return review as unknown as SessionPrReviewUpdate;
}

export function parsePrReviewActionOffer(
  payload: Record<string, unknown> | null | undefined,
): PrReviewActionOffer | null {
  const value = payload?.[PR_REVIEW_ACTION_OFFER_PAYLOAD_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const offer = value as Record<string, unknown>;
  if (
    typeof offer.deliveryId !== 'string' ||
    typeof offer.question !== 'string' ||
    !['pending', 'resolved', 'auto_resolved', 'dismissed', 'stale'].includes(
      String(offer.status),
    )
  ) {
    return null;
  }

  return offer as unknown as PrReviewActionOffer;
}

const PR_REVIEW_CALLBACK_PREFIX = 'prr:';
const CALLBACK_CHOICE_CODES: Record<PrReviewActionChoice, string> = {
  yes: 'y',
  auto: 'a',
  dismiss: 'd',
};

export function buildPrReviewActionCallbackData(
  choice: PrReviewActionChoice,
  nonce: string,
): string {
  return `${PR_REVIEW_CALLBACK_PREFIX}${CALLBACK_CHOICE_CODES[choice]}:${nonce}`;
}

export function parsePrReviewActionCallbackData(
  data: string | undefined,
): { choice: PrReviewActionChoice; nonce: string } | null {
  if (!data?.startsWith(PR_REVIEW_CALLBACK_PREFIX)) {
    return null;
  }

  const match = data.match(/^prr:([yad]):([A-Za-z0-9-]{8,40})$/);

  if (!match) {
    return null;
  }

  const choice = (
    Object.entries(CALLBACK_CHOICE_CODES) as Array<
      [PrReviewActionChoice, string]
    >
  ).find(([, code]) => code === match[1])?.[0];

  return choice ? { choice, nonce: match[2]! } : null;
}
