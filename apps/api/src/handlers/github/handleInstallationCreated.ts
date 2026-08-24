import { completePendingGitHubInstallation } from '@roomote/github';
import { attemptUserDirectMessage } from '@roomote/sdk/server';
import { Env } from '@roomote/env';
import { communicationProviders } from '@roomote/types';

import type { WebhookResponse } from '../../types';

import type { WebhookInstallationCreated } from './types';

function buildInstallationApprovedMessage(accountLogin: string): string {
  const setupUrl = new URL('/setup', Env.R_APP_URL).toString();

  return `Your GitHub installation request for ${accountLogin} was approved, and Roomote is now connected. Continue setup here: ${setupUrl}`;
}

export async function handleInstallationCreated(
  payload: WebhookInstallationCreated,
): Promise<WebhookResponse> {
  try {
    const result = await completePendingGitHubInstallation(
      payload.installation.id,
    );

    if (result.success) {
      // The requester was waiting on a GitHub org owner's approval; let them
      // know on whichever chat integrations they have linked.
      const text = buildInstallationApprovedMessage(
        result.githubInstallation.accountLogin,
      );
      await Promise.all(
        communicationProviders.map((provider) =>
          attemptUserDirectMessage({
            provider,
            userId: result.requestedByUserId,
            text,
            logContext: 'handleInstallationCreated',
          }),
        ),
      );
    }
  } catch (error) {
    console.error(
      `[handleInstallationCreated] Failed to complete pending GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { status: 'ok' };
}
