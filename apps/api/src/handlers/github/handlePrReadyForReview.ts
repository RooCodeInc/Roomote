import type { WebhookResponse } from '../../types';

import type { WebhookPullRequestReadyForReview } from './types';
import { handlePrOpen } from './handlePrOpen';

export async function handlePrReadyForReview(
  payload: WebhookPullRequestReadyForReview,
): Promise<WebhookResponse> {
  return handlePrOpen(payload, { isDraftToReady: true });
}
