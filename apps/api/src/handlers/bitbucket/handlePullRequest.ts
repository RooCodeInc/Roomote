import pMap from 'p-map';

import {
  type TaskPayload,
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  TaskPayloadKind,
} from '@roomote/types';
import {
  db,
  repositories,
  and,
  eq,
  findActiveGitHubPrReviewTask,
} from '@roomote/db/server';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  recordPrStatusChangeInTaskHistory,
  PrStatusFastDeliveryError,
  PrStatusHistoryRecordingError,
  updateTaskPrStatus,
} from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { scheduleNotifyPullRequestTerminalStatus } from '../github/notifyPullRequestTerminalStatus';
import { scheduleSourceControlPullRequestFactSync } from '../pull-request-fact-sync';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import {
  getBitbucketAutomationTargets,
  getBitbucketUsername,
  getBitbucketUserAccountKey,
} from './getBitbucketAutomationTargets';
import {
  getBitbucketPullRequestBaseRef,
  getBitbucketPullRequestBaseSha,
  getBitbucketPullRequestHeadRef,
  getBitbucketPullRequestHeadSha,
  getBitbucketPullRequestNumber,
  getBitbucketPullRequestUrl,
  isBitbucketPullRequestClosed,
  isBitbucketPullRequestMerged,
  type BitbucketPullRequestWebhook,
} from './types';

function getReviewTaskType(
  eventName: string,
):
  | typeof TaskPayloadKind.GithubPrReview
  | typeof TaskPayloadKind.GithubPrReviewSync
  | null {
  if (eventName === 'pullrequest:created') {
    return TaskPayloadKind.GithubPrReview;
  }

  if (eventName === 'pullrequest:updated') {
    return TaskPayloadKind.GithubPrReviewSync;
  }

  return null;
}

async function notifyTerminalPullRequestThreads(
  payload: BitbucketPullRequestWebhook,
  repoFullName: string,
  status: 'merged' | 'closed',
  includeFastParentTargets: boolean,
  includeFastParentTaskIds: string[],
): Promise<void> {
  const prUrl = getBitbucketPullRequestUrl(payload);
  const webhookHost = toHostFromUrl(prUrl);
  const repositoryRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'bitbucket'),
      eq(repositories.fullName, repoFullName),
      eq(repositories.isActive, true),
    ),
    columns: { id: true, host: true },
  });
  const repositoryRow = pickHostScopedRepository(repositoryRows, webhookHost);

  if (!repositoryRow) {
    return;
  }

  const prNumber = getBitbucketPullRequestNumber(payload.pullrequest);

  scheduleNotifyPullRequestTerminalStatus(
    {
      sourceControlProvider: 'bitbucket',
      repository: repoFullName,
      repositoryId: repositoryRow.id,
      host: repositoryRow.host ?? webhookHost,
      prNumber,
      prTitle: payload.pullrequest.title,
      prUrl,
      status,
      actorLogin: getBitbucketUsername(payload.actor) ?? 'someone on Bitbucket',
      ...(includeFastParentTargets ? { includeFastParentTargets: true } : {}),
      ...(includeFastParentTaskIds.length ? { includeFastParentTaskIds } : {}),
    },
    `PR #${prNumber}`,
  );
}

export async function handleBitbucketPullRequest(
  payload: BitbucketPullRequestWebhook,
  eventName: string,
): Promise<WebhookResponse> {
  const repoFullName = payload.repository.full_name;
  const pullRequest = payload.pullrequest;
  const prNumber = getBitbucketPullRequestNumber(pullRequest);

  if (
    eventName === 'pullrequest:fulfilled' ||
    eventName === 'pullrequest:rejected' ||
    isBitbucketPullRequestClosed(pullRequest)
  ) {
    const merged = isBitbucketPullRequestMerged(pullRequest);
    const status = merged ? ('merged' as const) : ('closed' as const);

    await updateTaskPrStatus('bitbucket', repoFullName, prNumber, status);

    scheduleSourceControlPullRequestFactSync({
      provider: 'bitbucket',
      repositoryFullName: repoFullName,
      pullRequest: {
        number: prNumber,
        title: pullRequest.title,
        body: pullRequest.description ?? null,
        url: getBitbucketPullRequestUrl(payload),
        authorLogin: getBitbucketUsername(pullRequest.author) ?? null,
        state: status,
        createdAt: pullRequest.created_on ?? null,
        // Bitbucket exposes no merge timestamp; updated_on is the terminal
        // activity time on a merged/declined PR.
        updatedAt: pullRequest.updated_on ?? null,
      },
    });

    let includeFastParentTargets = false;
    let includeFastParentTaskIds: string[] = [];
    try {
      await recordPrStatusChangeInTaskHistory({
        sourceControlProvider: 'bitbucket',
        repository: repoFullName,
        prNumber,
        prTitle: pullRequest.title,
        prUrl: getBitbucketPullRequestUrl(payload),
        status,
        actorLogin:
          getBitbucketUsername(payload.actor) ?? 'someone on Bitbucket',
      });
    } catch (error) {
      if (error instanceof PrStatusFastDeliveryError) {
        includeFastParentTaskIds = error.taskIds;
      } else {
        includeFastParentTargets = !(
          error instanceof PrStatusHistoryRecordingError
        );
      }
      console.warn(
        `[handleBitbucketPullRequest] Failed to record PR status in task history for ${repoFullName}#${prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await notifyTerminalPullRequestThreads(
      payload,
      repoFullName,
      status,
      includeFastParentTargets,
      includeFastParentTaskIds,
    );

    return { status: 'ok' };
  }

  if (
    eventName === 'pullrequest:created' ||
    eventName === 'pullrequest:updated'
  ) {
    await updateTaskPrStatus(
      'bitbucket',
      repoFullName,
      prNumber,
      pullRequest.draft ? 'draft' : 'open',
    );
  }

  const taskType = getReviewTaskType(eventName);

  if (!taskType) {
    return {
      status: 'ok',
      message: `unsupported_pull_request_event:${eventName}`,
    };
  }

  const result = await getBitbucketAutomationTargets({
    workflow: 'pr_review',
    payload,
    // The PR web URL carries the instance host, matching repositories.host.
    webhookHost: toHostFromUrl(getBitbucketPullRequestUrl(payload)),
  });

  if (result.status === 'error') {
    return result;
  }

  const targets = result.targets.filter((target) => {
    const settings = target.settings as PrReviewSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEW_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEW_SETTINGS.reviewDraftPrs;

    if (!reviewOnCommit) {
      return false;
    }

    return !pullRequest.draft || reviewDraftPrs;
  });

  if (targets.length === 0) {
    return { status: 'ok', message: 'No Bitbucket PR reviewer targets found.' };
  }

  const headSha = getBitbucketPullRequestHeadSha(pullRequest);
  const headRef = getBitbucketPullRequestHeadRef(pullRequest);
  const baseRef = getBitbucketPullRequestBaseRef(pullRequest);
  const baseSha = getBitbucketPullRequestBaseSha(pullRequest);

  if (taskType === TaskPayloadKind.GithubPrReviewSync && headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha,
      sourceControlProvider: 'bitbucket',
    });

    if (activeReview?.taskId) {
      console.log(
        `[handleBitbucketPullRequest] ${repoFullName}#${prNumber} -> skip_already_reviewed_head (task: ${activeReview.taskId})`,
      );

      return {
        status: 'ok',
        message: 'Bitbucket PR head SHA already has an active review job.',
      };
    }
  }

  const prUrl = getBitbucketPullRequestUrl(payload);
  const prAuthorName = getBitbucketUsername(pullRequest.author);
  const prAuthorId =
    getBitbucketUserAccountKey(pullRequest.author) ?? prAuthorName;

  const enqueued = await pMap(targets, async (target) =>
    enqueueTask(
      {
        task: {
          type: taskType,
          payload: {
            repo: repoFullName,
            sourceControlProvider: 'bitbucket',
            // Pin repository resolution to the webhook repository's host so
            // same-name repositories on other hosts cannot be picked up.
            // Legacy rows without a recorded host omit the field.
            ...(target.repo.host
              ? { sourceControlHost: target.repo.host }
              : {}),
            prNumber,
            prTitle: pullRequest.title,
            prUrl,
            headSha,
            branchName: headRef,
            ...(headRef ? { branch: headRef } : {}),
            ...(headSha ? { sha: headSha } : {}),
            targetBranch: baseRef,
          } satisfies TaskPayload<typeof taskType>,
        },
        initiator: {
          kind: 'automation',
          key: 'review_code',
          ...(prAuthorId
            ? {
                actor: {
                  externalId: prAuthorId,
                  displayName: prAuthorName,
                },
              }
            : {}),
        },
        workflow: 'pr_review',
        surface: 'bitbucket',
        trigger: 'webhook',
        prLinkage: {
          provider: 'bitbucket',
          ...(target.repo.host ? { host: target.repo.host } : {}),
          repositoryId: target.repo.id,
          repository: repoFullName,
          prNumber,
          prUrl,
          prTitle: pullRequest.title,
          prSha: headSha || null,
          prBaseRef: baseRef ?? null,
          prBaseSha: baseSha ?? null,
        },
      },
      {
        launchClass: 'automation',
      },
    ),
  );

  return {
    status: 'ok',
    metadata: {
      ids: enqueued.flatMap((item) => (item ? [item.id] : [])),
    },
  };
}
