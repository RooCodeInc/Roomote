/**
 * Callback-data encoding for PR review-feedback notification buttons on
 * providers with opaque button payloads (Discord custom_id <= 100 chars,
 * Telegram callback_data <= 64 bytes): "prr:<choice-letter>:<nonce>".
 * Kept dependency-free so webhook dispatchers can parse without loading
 * server-side modules.
 */
export type PrReviewActionChoice = 'yes' | 'auto' | 'dismiss';

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
