import type { WebhookResponse } from '../../types';

import type { WebhookPullRequestClosed } from './types';
import { notifyDiscordPrMerge } from './notifyDiscordPrMerge';
import { notifySlackPrMerge } from './notifySlackPrMerge';
import { notifyTeamsPrMerge } from './notifyTeamsPrMerge';
import { notifyTelegramAndLinearPrMerge } from './notifyTelegramAndLinearPrMerge';

export const handlePrMerge = async ({
  installation,
  repository,
  pull_request,
  sender,
}: WebhookPullRequestClosed): Promise<WebhookResponse> => {
  // Only process merged PRs.
  if (!pull_request.merged || !pull_request.merged_at) {
    return { status: 'ok' };
  }

  // Notify communication threads/sessions associated with this PR
  // (fire-and-forget).
  if (installation?.id) {
    const notificationParams = {
      sourceControlProvider: 'github' as const,
      installationId: installation.id,
      repository: repository.full_name,
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      prUrl: pull_request.html_url,
      mergedBy: pull_request.merged_by?.login || sender.login,
    };

    notifySlackPrMerge(notificationParams).catch((error) => {
      console.error(
        `[handlePrMerge] Failed to notify Slack for PR #${pull_request.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    notifyTeamsPrMerge(notificationParams).catch((error) => {
      console.error(
        `[handlePrMerge] Failed to notify Teams for PR #${pull_request.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    notifyDiscordPrMerge(notificationParams).catch((error) => {
      console.error(
        `[handlePrMerge] Failed to notify Discord for PR #${pull_request.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    notifyTelegramAndLinearPrMerge({
      ...notificationParams,
      sourceControlProvider: 'github',
    }).catch((error) => {
      console.error(
        `[handlePrMerge] Failed to notify Telegram/Linear for PR #${pull_request.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  return { status: 'ok' };
};
