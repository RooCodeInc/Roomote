import type { WebhookResponse } from '../../types';

import type { WebhookPullRequestReopened } from './types';
import { handlePrOpen } from './handlePrOpen';

export async function handlePrReopen(
  payload: WebhookPullRequestReopened,
): Promise<WebhookResponse> {
  return handlePrOpen(payload);
}
