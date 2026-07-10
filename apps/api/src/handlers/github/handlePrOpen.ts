import pMap from 'p-map';

import {
  type CloudTaskPayload,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
  TaskPayloadKind,
  CloudAgentType,
} from '@roomote/types';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';

import type { WebhookResponse } from '../../types';

import type {
  WebhookPullRequestOpened,
  WebhookPullRequestReadyForReview,
  WebhookPullRequestReopened,
} from './types';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { getBackgroundGithubTaskProperties } from './backgroundGithubTaskProperties';
import { getReviewTaskRelayPayload } from './reviewTaskRelayPayload';

export async function handlePrOpen(
  {
    installation,
    repository,
    pull_request: pr,
    sender,
  }:
    | WebhookPullRequestOpened
    | WebhookPullRequestReadyForReview
    | WebhookPullRequestReopened,
  options?: { isDraftToReady?: boolean },
): Promise<WebhookResponse> {
  if (pr.locked) {
    return { status: 'error', message: 'PR is locked' };
  }

  const result = await getGitHubAutomationTargets({
    type: CloudAgentType.PrReviewer,
    installation,
    repository,
    sender,
    author: pr.user?.login?.toLowerCase(),
  });

  if (result.status === 'error') {
    return result;
  }

  const { targets: allTargets } = result;

  const targets = allTargets.filter((target) => {
    const settings = target.settings as PrReviewerSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEWER_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEWER_SETTINGS.reviewDraftPrs;

    if (!reviewOnCommit) {
      return false;
    }

    if (options?.isDraftToReady) {
      return !reviewDraftPrs;
    }

    return !pr.draft || reviewDraftPrs;
  });

  if (targets.length === 0) {
    return { status: 'ok', message: 'No PR reviewer targets found.' };
  }

  console.log(
    `[handlePrOpen] ${repository.full_name}#${pr.number} -> enqueueCloudTask (background_review_task: true)`,
  );

  const enqueued = await pMap(targets, async (target) => {
    const relayPayload = await getReviewTaskRelayPayload({
      repository: repository.full_name,
      prNumber: pr.number,
      branchName: pr.head.ref,
      prBody: pr.body ?? null,
      reviewerSettings: target.settings,
    });

    return enqueueCloudTask({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        ...getBackgroundGithubTaskProperties(target.properties),
        payload: {
          repo: repository.full_name,
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.html_url,
          headSha: pr.head.sha,
          branchName: pr.head.ref,
          ...relayPayload,
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.GithubPrReview>,
      },
      initiator: {
        kind: 'automation',
        key: 'review_code',
        actor: { externalId: String(sender.id), displayName: sender.login },
      },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: {
        provider: 'github',
        repository: repository.full_name,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prTitle: pr.title,
        prSha: pr.head.sha,
        prBaseRef: pr.base?.ref ?? null,
        prBaseSha: pr.base?.sha ?? null,
      },
    });
  });

  return {
    status: 'ok',
    metadata: {
      ids: enqueued.flatMap((item) => (item ? [item.id] : [])),
    },
  };
}
