import type { WebhookResponse } from '../../types';

import type { WebhookPullRequestClosed } from './types';
import { scheduleNotifyPullRequestTerminalStatus } from './notifyPullRequestTerminalStatus';
import { toHostFromUrl } from '../utils';

export const handlePrMerge = async (
  { installation, repository, pull_request, sender }: WebhookPullRequestClosed,
  options: {
    includeFastParentTargets?: boolean;
    includeFastParentTaskIds?: string[];
  } = {},
): Promise<WebhookResponse> => {
  const status = pull_request.merged
    ? ('merged' as const)
    : ('closed' as const);

  // Notify Slack, Teams, Telegram, Discord, and Linear threads/sessions associated
  // with this PR when it becomes terminal (merged or closed). Fire-and-forget.
  if (installation?.id) {
    scheduleNotifyPullRequestTerminalStatus(
      {
        sourceControlProvider: 'github',
        installationId: installation.id,
        repository: repository.full_name,
        host: toHostFromUrl(pull_request.html_url),
        prNumber: pull_request.number,
        prTitle: pull_request.title,
        prUrl: pull_request.html_url,
        status,
        actorLogin:
          (pull_request.merged ? pull_request.merged_by?.login : null) ||
          sender.login,
        ...(options.includeFastParentTargets
          ? { includeFastParentTargets: true }
          : {}),
        ...(options.includeFastParentTaskIds?.length
          ? { includeFastParentTaskIds: options.includeFastParentTaskIds }
          : {}),
      },
      `PR #${pull_request.number}`,
    );
  }

  return { status: 'ok' };
};
