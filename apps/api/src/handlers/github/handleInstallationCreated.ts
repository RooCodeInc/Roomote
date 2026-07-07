import { completePendingGitHubInstallation } from '@roomote/github';

import type { WebhookResponse } from '../../types';

import type { WebhookInstallationCreated } from './types';

export async function handleInstallationCreated(
  payload: WebhookInstallationCreated,
): Promise<WebhookResponse> {
  try {
    await completePendingGitHubInstallation(payload.installation.id);
  } catch (error) {
    console.error(
      `[handleInstallationCreated] Failed to complete pending GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { status: 'ok' };
}
