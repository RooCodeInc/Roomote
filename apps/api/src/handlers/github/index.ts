import { Hono } from 'hono';
import { Webhooks } from '@octokit/webhooks';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import { isRepoSkipped, resolveConfiguredGitHubAppSlug } from '@roomote/github';
import {
  markTaskPullRequestTerminal,
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
import { handlePrComment } from './handlePrComment';

// PR merge handling:
import { handlePrMerge } from './handlePrMerge';

// Review-activity notifications:
import {
  queuePrReviewActivityNotification,
  queuePrReviewSummaryNotification,
} from './notifyPrReviewActivity';

// Conflict Resolution:
import { handlePushConflictCheck } from './handlePushConflictCheck';
import { handleWorkflowRunCompleted } from './handleWorkflowRunCompleted';

// Utilities:
import { recordWebhook } from './recordWebhook';

/**
 * Fire-and-forget PR status update. Logs errors but never throws.
 */
function syncPrStatus(
  repo: string,
  prNumber: number,
  status: PullRequestStatus,
): void {
  updateTaskPrStatus('github', repo, prNumber, status).catch((error) =>
    console.warn(
      `[syncPrStatus] Failed to update PR status for ${repo}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
}

function syncPullRequestFact(params: {
  githubRepoId: number;
  repositoryFullName: string;
  pullRequest: {
    authorLogin: string | null;
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

    webhooks.on('issue_comment.created', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping comment webhook for ${payload.repository.full_name}`,
          };
        }

        if (!payload.issue.pull_request) {
          return { status: 'ok' as const, message: 'not_a_pr_comment' };
        }

        queuePrReviewSummaryNotification(payload);

        return handlePrComment(payload);
      }),
    );

    webhooks.on('issue_comment.edited', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping comment webhook for ${payload.repository.full_name}`,
          };
        }

        if (!payload.issue.pull_request) {
          return { status: 'ok' as const, message: 'not_a_pr_comment' };
        }

        // Roomote review summaries are posted as "review in progress" and
        // patched with the results, so the terminal content arrives here.
        queuePrReviewSummaryNotification(payload);

        return { status: 'ok' as const };
      }),
    );

    webhooks.on('pull_request.opened', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          payload.pull_request.draft ? 'draft' : 'open',
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
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

        return handlePrOpen(payload);
      }),
    );

    webhooks.on('pull_request.reopened', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          'open',
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
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

        return handlePrSynchronize(payload);
      }),
    );

    webhooks.on('pull_request.ready_for_review', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        syncPrStatus(
          payload.repository.full_name,
          payload.pull_request.number,
          'open',
        );
        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
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

    webhooks.on('pull_request_review.submitted', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        if (isRepoSkipped(payload.repository.full_name)) {
          return {
            status: 'ok' as const,
            message: `Skipping review webhook for ${payload.repository.full_name}`,
          };
        }

        queuePrReviewActivityNotification(payload);

        return handlePrComment(payload);
      }),
    );

    webhooks.on(
      'pull_request_review_comment.created',
      ({ id, name, payload }) =>
        recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
          if (isRepoSkipped(payload.repository.full_name)) {
            return {
              status: 'ok' as const,
              message: `Skipping comment webhook for ${payload.repository.full_name}`,
            };
          }

          queuePrReviewActivityNotification(payload);

          return handlePrComment(payload);
        }),
    );

    webhooks.on('push', ({ id, name, payload }) =>
      recordWebhook(id, name, payload, () => handlePushConflictCheck(payload)),
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

    webhooks.on('pull_request.closed', ({ id, name, payload }) =>
      recordWebhook(id, `${name}.${payload.action}`, payload, async () => {
        const status = payload.pull_request.merged ? 'merged' : 'closed';
        const repository = payload.repository.full_name;
        const prNumber = payload.pull_request.number;

        void markTaskPullRequestTerminal(
          {
            sourceControlProvider: 'github',
            repository,
            prNumber,
            prTitle: payload.pull_request.title,
            prUrl: payload.pull_request.html_url,
            status,
            actorLogin:
              (payload.pull_request.merged
                ? payload.pull_request.merged_by?.login
                : null) || payload.sender.login,
          },
          { logLabel: 'pull_request.closed' },
        ).catch((error) =>
          console.warn(
            `[pull_request.closed] Failed to update PR status for ${repository}#${prNumber}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );

        syncPullRequestFact({
          githubRepoId: payload.repository.id,
          repositoryFullName: payload.repository.full_name,
          pullRequest: {
            authorLogin: payload.pull_request.user?.login ?? null,
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
            message: `Skipping merge webhook for ${payload.repository.full_name}`,
          };
        }

        return handlePrMerge(payload);
      }),
    );

    webhooks.onError((error) =>
      logApiError('[GitHub] processing error', error),
    );

    const payload = await c.req.text();

    // The event handlers classify logins synchronously (mention detection,
    // bot-identity checks); refresh the configured app slug first so an app
    // created through the /setup flow is recognized as ourselves.
    await resolveConfiguredGitHubAppSlug();

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
