import { Hono } from 'hono';
import { Webhooks } from '@octokit/webhooks';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import {
  isRepoSkipped,
  resolveConfiguredGitHubAppSlug,
  resolveGitHubRoomoteMentionEnabled,
} from '@roomote/github';
import {
  handleMergeAnnouncerPush,
  recordPrStatusChangeInTaskHistory,
  retirePendingPrReviewActionsForPullRequest,
  updateTaskPrStatus,
  upsertGitHubPullRequestFactFromWebhook,
} from '@roomote/sdk/server';
import type { PullRequestStatus } from '@roomote/types';

import { apiLogger, logApiError } from '../../logging';
// Onboarding:
import { handleInstallationCreated } from './handleInstallationCreated';

// Code Reviewer:
import { handlePrOpen } from './handlePrOpen';
import { handlePrReadyForReview } from './handlePrReadyForReview';
import { handlePrReopen } from './handlePrReopen';
import { handlePrSynchronize } from './handlePrSynchronize';
import { handleCheckRunRerequested } from './handleCheckRunRerequested';
import { getCurrentGitHubPrHeadSha } from './currentPrHead';
import type { WebhookPullRequestSynchronize } from './types';
import { handlePrComment } from './handlePrComment';
import { handleGitHubIssueComment } from './handleGitHubIssueComment';
import { handleGitHubIssueFixer } from './handleGitHubIssueFixer';

// PR merge handling:
import { handlePrMerge } from './handlePrMerge';

// Review-activity notifications:
import {
  queuePrReviewActivityNotification,
  queuePrReviewSummaryNotification,
} from './notifyPrReviewActivity';
import { queuePrCiFailureNotification } from './notifyPrCiFailure';

// Conflict Resolution:
import { handlePushConflictCheck } from './handlePushConflictCheck';
import { handleWorkflowRunCompleted } from './handleWorkflowRunCompleted';
import {
  queueBaseBranchMergeabilityCheck,
  queueTrackedPullRequestMergeabilityCheck,
} from './queuePullRequestMergeabilityCheck';

// Repository metadata sync:
import { handleRepositoryEdited } from './handleRepositoryEdited';
import { handleInstallationRepositoriesChange } from './handleInstallationRepositoriesChange';

// Utilities:
import { isFromKnownInstallation } from './isFromKnownInstallation';
import { recordWebhook } from './recordWebhook';
import {
  enrichGitHubMergeAnnouncerEvent,
  normalizeGitHubPush,
} from '../merge-announcer-push';

/**
 * Fire-and-forget PR status update. Logs errors but never throws.
 */
function syncPrStatus(
  repo: string,
  prNumber: number,
  status: PullRequestStatus,
): Promise<void> {
  return updateTaskPrStatus('github', repo, prNumber, status).catch((error) =>
    console.warn(
      `[syncPrStatus] Failed to update PR status for ${repo}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
}

function mapGitHubLabels(
  labels: readonly { name?: string | null }[] | null | undefined,
): string[] | null {
  if (!labels) {
    return null;
  }

  return labels
    .map((label) => label.name)
    .filter((name): name is string => Boolean(name));
}

function syncPullRequestFact(params: {
  githubRepoId: number;
  repositoryFullName: string;
  pullRequest: {
    authorLogin: string | null;
    body: string | null;
    labels: string[] | null;
    closedAt: string | null;
    createdAt: string;
    draft: boolean;
    externalPullRequestId: number;
    mergedAt: string | null;
    number: number;
    state: 'open' | 'closed';
    title: string;
    updatedAt: string;
    url: string;
  };
}): void {
  const state = params.pullRequest.mergedAt
    ? 'merged'
    : params.pullRequest.draft
      ? 'draft'
      : params.pullRequest.state === 'closed'
        ? 'closed'
        : 'open';

  upsertGitHubPullRequestFactFromWebhook({
    githubRepoId: params.githubRepoId,
    repositoryFullName: params.repositoryFullName,
    pullRequest: {
      authorLogin: params.pullRequest.authorLogin,
      body: params.pullRequest.body,
      labels: params.pullRequest.labels,
      closedAt: params.pullRequest.closedAt,
      createdAt: params.pullRequest.createdAt,
      externalPullRequestId: params.pullRequest.externalPullRequestId,
      mergedAt: params.pullRequest.mergedAt,
      number: params.pullRequest.number,
      state,
      title: params.pullRequest.title,
      updatedAt: params.pullRequest.updatedAt,
      url: params.pullRequest.url,
    },
  }).catch((error) =>
    console.warn(
      `[syncPullRequestFact] Failed to upsert PR fact for ${params.repositoryFullName}#${params.pullRequest.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
}

/**
 * Retires review offers whose controls belong to an older head once a PR
 * receives a new commit. The live head is resolved from GitHub rather than
 * trusted from the payload, so a late or redelivered `synchronize` for an
 * older commit cannot dismiss offers for the actual current head. Runs
 * best-effort in the background: the offers are cosmetic, and failing here
 * must not block fact sync, mergeability checks, or review-on-commit.
 */
function retireStalePrReviewActions(
  payload: WebhookPullRequestSynchronize,
): void {
  const repository = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const installationId = payload.installation?.id;
  if (!installationId) return;

  void (async () => {
    const currentHeadSha = await getCurrentGitHubPrHeadSha({
      installationId,
      repository,
      prNumber,
    });
    if (!currentHeadSha) {
      apiLogger.warn(
        `[retireStalePrReviewActions] Skipping ${repository}#${prNumber}: live head unavailable`,
      );
      return;
    }
    await retirePendingPrReviewActionsForPullRequest({
      sourceControlProvider: 'github',
      repository,
      prNumber,
      currentHeadSha,
    });
  })().catch((error) => {
    apiLogger.error(
      `[retireStalePrReviewActions] Failed for ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

// Resolve through the deployment env resolver so a secret saved into
// encrypted environment_variables by the /setup manifest flow verifies
// without also being copied into the process environment. Non-empty values
// are cached briefly to avoid a decrypting DB read on every delivery; misses
// are not cached so a freshly saved secret is picked up immediately.
const WEBHOOK_SECRET_CACHE_TTL_MS = 60_000;

let webhookSecretCache: { value: string; expiresAt: number } | null = null;

async function resolveGitHubWebhookSecret(): Promise<string | null> {
  if (webhookSecretCache && webhookSecretCache.expiresAt > Date.now()) {
    return webhookSecretCache.value;
  }

  const secret = await resolveDeploymentEnvVar('R_GITHUB_WEBHOOK_SECRET');

  if (!secret) {
    return null;
  }

  webhookSecretCache = {
    value: secret,
    expiresAt: Date.now() + WEBHOOK_SECRET_CACHE_TTL_MS,
  };

  return secret;
}

export const github = new Hono();

github.post('/', async (c) => {
  try {
    const headers = c.req.header();
    const id = headers['x-github-delivery'];
    const name = headers['x-github-event'];
    const signature = headers['x-hub-signature-256'];

    if (!id || !name || !signature) {
      apiLogger.debug(
        `[GitHub] missing headers: ${JSON.stringify({ id, name, signature })}`,
      );

      return c.json({ error: 'missing_headers' }, { status: 400 });
    }

    const secret = await resolveGitHubWebhookSecret();

    if (!secret) {
      apiLogger.debug('[GitHub] webhook secret is not configured');
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    const webhooks = new Webhooks({ secret });

    webhooks.on('installation.created', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, () =>
        handleInstallationCreated(payload),
      ),
    );

    webhooks.on('issue_comment.created', async ({ id, name, payload }) => {
      // Review activity is the durable ingress boundary. Persist it before
      // generic webhook auditing or any downstream handler so a crash or
      // retry cannot lose accepted feedback. Provider object ids make this
      // operation idempotent across duplicate deliveries.
      if (payload.issue.pull_request) {
        await Promise.all([
          queuePrReviewActivityNotification(payload, id),
          queuePrReviewSummaryNotification(payload, id),
        ]);
      }

      return recordWebhook(
        id,
        `${name}.${payload.action}`,
        payload,
        async () => {
          // Mentions are not subject to the automated skip list: a person
          // addressing this app by name gets a response even in repositories
          // where unsolicited automations are suppressed. The handlers return
          // `no_mention` for everything else.
          if (!payload.issue.pull_request) {
            return handleGitHubIssueComment(payload);
          }

          return handlePrComment(payload);
        },
      );
    });

    webhooks.on('issue_comment.edited', async ({ id, name, payload }) => {
      if (payload.issue.pull_request) {
        // Roomote summaries and external top-level review comments can both
        // be edited from placeholder content into their final result.
        await Promise.all([
          queuePrReviewActivityNotification(payload, id),
          queuePrReviewSummaryNotification(payload, id),
        ]);
      }

      return recordWebhook(
        id,
        `${name}.${payload.action}`,
        payload,
        async () => {
          if (!payload.issue.pull_request) {
            return { status: 'ok' as const, message: 'not_a_pr_comment' };
          }

          return { status: 'ok' as const };
        },
      );
    });

    webhooks.on('issues.opened', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        const mentionResult = await handleGitHubIssueComment({
          installation: payload.installation,
          repository: payload.repository,
          sender: payload.sender,
          issue: payload.issue,
          mentionBody: payload.issue.body ?? '',
        });

        // Triage Issues is unsolicited automation, so the skip list applies
        // to it but not to the body mention above.
        if (isRepoSkipped(payload.repository.full_name)) {
          return mentionResult;
        }

        // Always run Triage Issues when enabled (immediate, like Review Code).
        // Mentions and Triage Issues are independent: a mention still starts a
        // conversation task, while Triage Issues may launch a hidden plan task.
        const fixerResult = await handleGitHubIssueFixer(payload);

        if (fixerResult.status === 'error') {
          return fixerResult;
        }

        return mentionResult;
      }),
    );

    webhooks.on('issues.reopened', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping issue webhook for ${payload.repository.full_name}`,
          };
        }

        return handleGitHubIssueFixer(payload);
      }),
    );

    webhooks.on('pull_request.opened', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        await syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          payload.pull_request.draft ? 'draft' : 'open',
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
            body: payload.pull_request.body ?? null,
            labels: mapGitHubLabels(payload.pull_request.labels),
            closedAt: payload.pull_request.closed_at,
            createdAt: payload.pull_request.created_at,
            draft: Boolean(payload.pull_request.draft),
            externalPullRequestId: payload.pull_request.id,
            mergedAt: payload.pull_request.merged_at,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            title: payload.pull_request.title,
            updatedAt: payload.pull_request.updated_at,
            url: payload.pull_request.html_url,
          },
        });
        await queueTrackedPullRequestMergeabilityCheck(payload);

        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping review webhook for ${payload.repository.full_name}`,
          };
        }

        return handlePrOpen(payload);
      }),
    );

    webhooks.on('pull_request.reopened', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        await syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          payload.pull_request.draft ? 'draft' : 'open',
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
            body: payload.pull_request.body ?? null,
            labels: mapGitHubLabels(payload.pull_request.labels),
            closedAt: payload.pull_request.closed_at,
            createdAt: payload.pull_request.created_at,
            draft: Boolean(payload.pull_request.draft),
            externalPullRequestId: payload.pull_request.id,
            mergedAt: payload.pull_request.merged_at,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            title: payload.pull_request.title,
            updatedAt: payload.pull_request.updated_at,
            url: payload.pull_request.html_url,
          },
        });
        await queueTrackedPullRequestMergeabilityCheck(payload);

        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping review webhook for ${payload.repository.full_name}`,
          };
        }

        return handlePrReopen(payload);
      }),
    );

    webhooks.on('pull_request.synchronize', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
            body: payload.pull_request.body ?? null,
            labels: mapGitHubLabels(payload.pull_request.labels),
            closedAt: payload.pull_request.closed_at,
            createdAt: payload.pull_request.created_at,
            draft: Boolean(payload.pull_request.draft),
            externalPullRequestId: payload.pull_request.id,
            mergedAt: payload.pull_request.merged_at,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            title: payload.pull_request.title,
            updatedAt: payload.pull_request.updated_at,
            url: payload.pull_request.html_url,
          },
        });
        await queueTrackedPullRequestMergeabilityCheck(payload);
        retireStalePrReviewActions(payload);

        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping review webhook for ${payload.repository.full_name}`,
          };
        }

        return handlePrSynchronize(payload);
      }),
    );

    webhooks.on('pull_request.edited', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        if (!payload.changes.base) {
          return { status: 'ok' as const };
        }

        await queueTrackedPullRequestMergeabilityCheck(payload, {
          updateBaseRef: true,
        });
        return { status: 'ok' as const };
      }),
    );

    webhooks.on('pull_request.ready_for_review', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        // Awaited so the mergeability check below sees the row as 'open';
        // conflicts accrued while the PR was a draft surface at this
        // transition.
        await syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          'open',
        );
        await queueTrackedPullRequestMergeabilityCheck(payload);
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
            body: payload.pull_request.body ?? null,
            labels: mapGitHubLabels(payload.pull_request.labels),
            closedAt: payload.pull_request.closed_at,
            createdAt: payload.pull_request.created_at,
            draft: Boolean(payload.pull_request.draft),
            externalPullRequestId: payload.pull_request.id,
            mergedAt: payload.pull_request.merged_at,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            title: payload.pull_request.title,
            updatedAt: payload.pull_request.updated_at,
            url: payload.pull_request.html_url,
          },
        });

        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping review webhook for ${payload.repository.full_name}`,
          };
        }

        return handlePrReadyForReview(payload);
      }),
    );

    webhooks.on('pull_request.converted_to_draft', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          'draft',
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
            body: payload.pull_request.body ?? null,
            labels: mapGitHubLabels(payload.pull_request.labels),
            closedAt: payload.pull_request.closed_at,
            createdAt: payload.pull_request.created_at,
            draft: Boolean(payload.pull_request.draft),
            externalPullRequestId: payload.pull_request.id,
            mergedAt: payload.pull_request.merged_at,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            title: payload.pull_request.title,
            updatedAt: payload.pull_request.updated_at,
            url: payload.pull_request.html_url,
          },
        });

        return { status: 'ok' as const };
      }),
    );

    webhooks.on(
      'pull_request_review.submitted',
      async ({ id, name, payload }) => {
        await queuePrReviewActivityNotification(payload, id);

        return recordWebhook(
          id,
          `${name}.${payload.action}`,
          payload,
          async () => handlePrComment(payload),
        );
      },
    );

    webhooks.on(
      'pull_request_review_comment.created',
      async ({ id, name, payload }) => {
        await queuePrReviewActivityNotification(payload, id);

        return recordWebhook(
          id,
          `${name}.${payload.action}`,
          payload,
          async () => handlePrComment(payload),
        );
      },
    );

    webhooks.on('push', ({ id, name, payload }) =>
      recordWebhook(id, name, payload, async () => {
        const mergeAnnouncerEvent = normalizeGitHubPush(payload);
        const [result, , mergeAnnouncerResult] = await Promise.all([
          handlePushConflictCheck(payload),
          queueBaseBranchMergeabilityCheck(payload),
          mergeAnnouncerEvent
            ? enrichGitHubMergeAnnouncerEvent(
                payload,
                mergeAnnouncerEvent,
              ).then(handleMergeAnnouncerPush)
            : Promise.resolve({ status: 'ok' as const }),
        ]);
        return mergeAnnouncerResult.status === 'error'
          ? mergeAnnouncerResult
          : result;
      }),
    );

    webhooks.on('repository.edited', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, () =>
        handleRepositoryEdited(payload),
      ),
    );

    // Keep the stored repository list in sync as repos appear, disappear, or
    // change access. Selected-repos installs emit `installation_repositories`;
    // all-repos installs emit `repository.created/deleted` instead. Not gated
    // on isRepoSkipped: the row must exist even for skipped repos.
    webhooks.on(
      ['installation_repositories.added', 'installation_repositories.removed'],
      ({ id, name, payload }) =>
        recordWebhook(id, `${name}.${payload.action}`, payload, () =>
          handleInstallationRepositoriesChange(payload),
        ),
    );

    webhooks.on(
      ['repository.created', 'repository.deleted', 'repository.renamed'],
      ({ id, name, payload }) =>
        recordWebhook(id, `${name}.${payload.action}`, payload, () =>
          handleInstallationRepositoriesChange(payload),
        ),
    );

    webhooks.on('workflow_run.completed', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping workflow_run webhook for ${payload.repository.full_name}`,
          };
        }

        return handleWorkflowRunCompleted(payload);
      }),
    );

    webhooks.on('check_run.completed', async ({ id, name, payload }) => {
      await queuePrCiFailureNotification(payload);

      return recordWebhook(
        id,
        `${name}.${payload.action}`,
        payload,
        async () => ({ status: 'ok' as const }),
      );
    });

    webhooks.on('check_run.rerequested', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, () =>
        handleCheckRunRerequested(payload),
      ),
    );

    webhooks.on('pull_request.closed', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        const status = payload.pull_request.merged ? 'merged' : 'closed';

        await updateTaskPrStatus(
          'github',
          payload.repository.full_name,
          payload.pull_request.number,
          status,
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
            body: payload.pull_request.body ?? null,
            labels: mapGitHubLabels(payload.pull_request.labels),
            closedAt: payload.pull_request.closed_at,
            createdAt: payload.pull_request.created_at,
            draft: Boolean(payload.pull_request.draft),
            externalPullRequestId: payload.pull_request.id,
            mergedAt: payload.pull_request.merged_at,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            title: payload.pull_request.title,
            updatedAt: payload.pull_request.updated_at,
            url: payload.pull_request.html_url,
          },
        });

        // Persist merged/closed status into linked task history so agents get
        // the same out-of-band context path as PR review-feedback notifications.
        void Promise.resolve(
          recordPrStatusChangeInTaskHistory({
            sourceControlProvider: 'github',
            repository: payload.repository.full_name,
            prNumber: payload.pull_request.number,
            prTitle: payload.pull_request.title,
            prUrl: payload.pull_request.html_url,
            targetBranch: payload.pull_request.base.ref,
            status,
            actorLogin:
              (payload.pull_request.merged
                ? payload.pull_request.merged_by?.login
                : null) || payload.sender.login,
          }),
        ).catch((error) => {
          console.warn(
            `[pull_request.closed] Failed to record PR status in task history for ${payload.repository.full_name}#${payload.pull_request.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

        // Skipped repositories suppress automated review work, not lifecycle
        // notifications for tasks that already track this pull request.
        return handlePrMerge(payload);
      }),
    );

    webhooks.onError((error) =>
      logApiError('[GitHub] processing error', error),
    );

    const payload = await c.req.text();

    // Verify the signature before the installation lookup so unsigned junk
    // cannot trigger database reads.
    if (!(await webhooks.verify(payload, signature))) {
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    // The app is public, so any account can install it and produce validly
    // signed deliveries; drop events from installations this deployment does
    // not know before they are recorded or handled.
    if (!(await isFromKnownInstallation(name, payload))) {
      apiLogger.debug(
        `[GitHub] ignoring webhook ${id} (${name}) from unknown installation`,
      );

      return c.json({ message: 'unknown_installation' });
    }

    // The event handlers classify logins synchronously (mention detection,
    // bot-identity checks); refresh the configured app slug first so an app
    // created through the /setup flow is recognized as ourselves.
    await Promise.all([
      resolveConfiguredGitHubAppSlug(),
      resolveGitHubRoomoteMentionEnabled(),
    ]);

    await webhooks.verifyAndReceive({ id, name, signature, payload });
    return c.json({ message: 'webhook_processed' });
  } catch (error) {
    logApiError('[GitHub] caught error', error);

    if (error instanceof Error && error.message.includes('signature')) {
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    return c.json({ error: 'internal_server_error' }, { status: 500 });
  }
});
