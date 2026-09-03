import pMap from 'p-map';

import {
  buildFastAgentSessionAttachment,
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
import {
  enqueueTask,
  getPrOriginFastAgentParent,
} from '@roomote/cloud-agents/server';
import {
  recordPrStatusChangeInTaskHistory,
  updateTaskPrStatus,
} from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { scheduleNotifyPullRequestTerminalStatus } from '../github/notifyPullRequestTerminalStatus';
import { scheduleSourceControlPullRequestFactSync } from '../pull-request-fact-sync';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import {
  getGiteaAutomationTargets,
  getGiteaUsername,
} from './getGiteaAutomationTargets';
import type { GiteaPullRequestWebhook } from './types';

function getPullRequestHeadSha(payload: GiteaPullRequestWebhook): string {
  return payload.pull_request.head?.sha ?? payload.commit_id ?? '';
}

function getPullRequestUrl(payload: GiteaPullRequestWebhook): string {
  return (
    payload.pull_request.html_url ??
    payload.pull_request.url ??
    `${payload.repository.html_url ?? ''}/pulls/${payload.number}`
  );
}

function getReviewTaskType(
  payload: GiteaPullRequestWebhook,
):
  | typeof TaskPayloadKind.GithubPrReview
  | typeof TaskPayloadKind.GithubPrReviewSync
  | null {
  const action = payload.action;

  if (action === 'opened' || action === 'reopened') {
    return TaskPayloadKind.GithubPrReview;
  }

  if (action === 'synchronized') {
    return TaskPayloadKind.GithubPrReviewSync;
  }

  return null;
}

async function notifyTerminalPullRequestThreads(
  payload: GiteaPullRequestWebhook,
  repoFullName: string,
  status: 'merged' | 'closed',
): Promise<void> {
  const prUrl = getPullRequestUrl(payload);
  const webhookHost = toHostFromUrl(prUrl);
  const repositoryRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'gitea'),
      eq(repositories.fullName, repoFullName),
      eq(repositories.isActive, true),
    ),
    columns: { id: true, host: true },
  });
  const repositoryRow = pickHostScopedRepository(repositoryRows, webhookHost);

  if (!repositoryRow) {
    return;
  }

  scheduleNotifyPullRequestTerminalStatus(
    {
      sourceControlProvider: 'gitea',
      repository: repoFullName,
      repositoryId: repositoryRow.id,
      host: repositoryRow.host ?? webhookHost,
      prNumber: payload.number,
      prTitle: payload.pull_request.title,
      prUrl,
      status,
      actorLogin: getGiteaUsername(payload.sender) ?? 'someone on Gitea',
    },
    `PR #${payload.number}`,
  );
}

export async function handleGiteaPullRequest(
  payload: GiteaPullRequestWebhook,
): Promise<WebhookResponse> {
  const repoFullName = payload.repository.full_name;
  const pullRequest = payload.pull_request;

  if (payload.action === 'closed') {
    const status = pullRequest.merged
      ? ('merged' as const)
      : ('closed' as const);

    await updateTaskPrStatus('gitea', repoFullName, payload.number, status);

    scheduleSourceControlPullRequestFactSync({
      provider: 'gitea',
      repositoryFullName: repoFullName,
      pullRequest: {
        number: payload.number,
        externalId: pullRequest.id ?? null,
        title: pullRequest.title,
        body: pullRequest.body ?? null,
        url: getPullRequestUrl(payload),
        authorLogin: getGiteaUsername(pullRequest.user) ?? null,
        state: status,
        createdAt: pullRequest.created_at ?? null,
        updatedAt: pullRequest.updated_at ?? null,
        mergedAt: pullRequest.merged_at ?? null,
      },
    });

    await Promise.resolve(
      recordPrStatusChangeInTaskHistory({
        sourceControlProvider: 'gitea',
        repository: repoFullName,
        prNumber: payload.number,
        prTitle: pullRequest.title,
        prUrl: getPullRequestUrl(payload),
        targetBranch: pullRequest.base?.ref,
        status,
        actorLogin: getGiteaUsername(payload.sender) ?? 'someone on Gitea',
      }),
    ).catch((error) => {
      console.warn(
        `[handleGiteaPullRequest] Failed to record PR status in task history for ${repoFullName}#${payload.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    await notifyTerminalPullRequestThreads(payload, repoFullName, status);

    return { status: 'ok' };
  }

  if (payload.action === 'opened' || payload.action === 'reopened') {
    await updateTaskPrStatus(
      'gitea',
      repoFullName,
      payload.number,
      pullRequest.draft ? 'draft' : 'open',
    );
  }

  const taskType = getReviewTaskType(payload);

  if (!taskType) {
    return {
      status: 'ok',
      message: `unsupported_pull_request_action:${payload.action}`,
    };
  }

  const result = await getGiteaAutomationTargets({
    workflow: 'pr_review',
    payload,
    // The PR web URL carries the instance host, matching repositories.host.
    webhookHost: toHostFromUrl(getPullRequestUrl(payload)),
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
    return { status: 'ok', message: 'No Gitea PR reviewer targets found.' };
  }

  const headSha = getPullRequestHeadSha(payload);

  if (taskType === TaskPayloadKind.GithubPrReviewSync && headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber: payload.number,
      headSha,
      sourceControlProvider: 'gitea',
    });

    if (activeReview?.taskId) {
      console.log(
        `[handleGiteaPullRequest] ${repoFullName}#${payload.number} -> skip_already_reviewed_head (task: ${activeReview.taskId})`,
      );

      return {
        status: 'ok',
        message: 'Gitea PR head SHA already has an active review job.',
      };
    }
  }

  const prUrl = getPullRequestUrl(payload);
  const prAuthorName = getGiteaUsername(pullRequest.user);
  const prAuthorId =
    pullRequest.user?.id != null ? String(pullRequest.user.id) : prAuthorName;

  const enqueued = await pMap(targets, async (target) => {
    // A PR opened by a session-delegated task pulls its review into that
    // same session, so the review shows up as a task there instead of
    // spawning an unrelated one.
    const reviewBranch = pullRequest.head?.ref;
    const originParent = reviewBranch
      ? await getPrOriginFastAgentParent({
          repository: repoFullName,
          prNumber: payload.number,
          branchName: reviewBranch,
          sourceControlProvider: 'gitea',
          host: target.repo.host,
        }).catch(() => null)
      : null;
    return enqueueTask(
      {
        task: {
          type: taskType,
          payload: {
            repo: repoFullName,
            sourceControlProvider: 'gitea',
            // Pin repository resolution to the webhook repository's host so
            // same-name repositories on other hosts cannot be picked up.
            // Legacy rows without a recorded host omit the field.
            ...(target.repo.host
              ? { sourceControlHost: target.repo.host }
              : {}),
            ...(originParent
              ? buildFastAgentSessionAttachment(originParent)
              : {}),
            prNumber: payload.number,
            prTitle: pullRequest.title,
            prUrl,
            headSha,
            branchName: pullRequest.head?.ref,
            ...(pullRequest.head?.ref ? { branch: pullRequest.head.ref } : {}),
            ...(headSha ? { sha: headSha } : {}),
            targetBranch: pullRequest.base?.ref,
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
        surface: 'gitea',
        trigger: 'webhook',
        prLinkage: {
          provider: 'gitea',
          ...(target.repo.host ? { host: target.repo.host } : {}),
          repositoryId: target.repo.id,
          repository: repoFullName,
          prNumber: payload.number,
          prUrl,
          prTitle: pullRequest.title,
          prSha: headSha || null,
          prBaseRef: pullRequest.base?.ref ?? null,
          prBaseSha: pullRequest.base?.sha ?? null,
        },
      },
      {
        launchClass: 'automation',
      },
    );
  });

  return {
    status: 'ok',
    metadata: {
      ids: enqueued.flatMap((item) => (item ? [item.id] : [])),
    },
  };
}
