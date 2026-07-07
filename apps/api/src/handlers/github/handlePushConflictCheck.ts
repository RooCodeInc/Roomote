import { getRedis } from '@roomote/redis';
import { getInstallationOctokit, isRepoSkipped } from '@roomote/github';
import {
  db,
  repositories,
  eq,
  and,
  getBackgroundAgentSettingsForDeployment,
} from '@roomote/db/server';

import type { WebhookResponse } from '../../types';
import {
  discoverCandidates,
  processConflictCandidates,
  LOG_PREFIX,
} from './conflict-resolution';
import type { WebhookInstallation, WebhookRepository } from './types';

/**
 * Webhook payload shape for `push` events.
 *
 * We only need a small subset of the full push event.
 * The `owner` field may be null in the webhook payload,
 * so we handle that defensively.
 */
interface PushEventPayload {
  ref: string;
  repository: {
    id: number;
    full_name: string;
    name: string;
    owner: { login: string } | null;
  };
  installation?: { id: number } | null;
}

/**
 * Handle a GitHub `push` event by checking whether the pushed branch is
 * the base branch of any labeled, open PRs that might now have conflicts.
 *
 * This is the event-driven trigger for proactive conflict resolution.
 */
export async function handlePushConflictCheck(
  payload: PushEventPayload,
): Promise<WebhookResponse> {
  const installationId = payload.installation?.id;

  if (!installationId) {
    return { status: 'ok', message: 'No installation — skipping' };
  }

  // Extract the branch name from refs/heads/<branch>
  const refPrefix = 'refs/heads/';

  if (!payload.ref.startsWith(refPrefix)) {
    return { status: 'ok', message: 'Not a branch push — skipping' };
  }

  const branchName = payload.ref.slice(refPrefix.length);
  const repoFullName = payload.repository.full_name;

  if (isRepoSkipped(repoFullName)) {
    return {
      status: 'ok',
      message: `Skipping push webhook for ${repoFullName}`,
    };
  }

  const [owner, repoName] = repoFullName.split('/');

  if (!owner || !repoName) {
    return { status: 'error', message: `Invalid repo name: ${repoFullName}` };
  }

  // Look up the repo in our database to confirm it is tracked.
  const repoRow = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.githubRepoId, payload.repository.id),
      eq(repositories.isActive, true),
    ),
    with: {
      githubInstallation: true,
    },
  });

  if (!repoRow) {
    return { status: 'ok', message: 'Repo not tracked — skipping' };
  }

  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings.conflictResolverFrequency === 'off') {
    return {
      status: 'ok',
      message: 'Conflict resolver disabled for deployment',
    };
  }

  console.log(
    `${LOG_PREFIX} Push to ${repoFullName}/${branchName} — scanning for conflicting PRs`,
  );

  try {
    const redis = getRedis();
    const octokit = await getInstallationOctokit({ installationId });

    // Find candidate PRs targeting this branch as their base
    const candidates = await discoverCandidates(
      octokit,
      owner,
      repoName,
      branchName,
      settings.conflictResolverLabel,
      settings.conflictResolverMaxPrAgeDays,
    );

    if (candidates.length === 0) {
      return { status: 'ok', message: 'No candidate PRs found' };
    }

    const conflictingCount = await processConflictCandidates(
      octokit,
      redis,
      candidates,
      {
        installation: payload.installation as WebhookInstallation,
        repository: payload.repository as unknown as WebhookRepository,
      },
    );

    return {
      status: 'ok',
      message: `Processed ${candidates.length} candidates, ${conflictingCount} conflicting`,
    };
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Error processing push conflict check for ${repoFullName}:`,
      error instanceof Error ? error.message : error,
    );

    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
