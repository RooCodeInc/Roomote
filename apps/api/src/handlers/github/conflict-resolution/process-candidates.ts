import { TaskPayloadKind, CloudAgentType, PRODUCT_NAME } from '@roomote/types';
import { enqueueTask, getTaskUrl } from '@roomote/cloud-agents/server';
import {
  DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS,
  findActiveGitHubBranchWork,
  hasRecentGitHubBranchCommit,
} from '@roomote/db/server';
import { getCommitCommittedAt } from '@roomote/github';

import type { OctokitClient, RedisClient } from './types';
import { LOG_PREFIX } from './constants';
import type { ConflictCandidate } from './discover-candidates';
import { pollMergeability } from './check-mergeability';
import {
  postTaskStartFailureComment,
  postWorkingOnItComment,
} from './post-comment';
import { acquireRepoLock } from './repo-lock';
import { hasActiveResolutionJob } from './has-active-resolution-job';
import { getBackgroundGithubTaskProperties } from '../backgroundGithubTaskProperties';

import { getGitHubAutomationTargets } from '../getGitHubAutomationTargets';
import type {
  WebhookInstallation,
  WebhookRepository,
  WebhookUser,
} from '../types';

interface ProcessCandidatesContext {
  installation: WebhookInstallation;
  repository: WebhookRepository;
}

/**
 * Process a list of conflict candidates for a single repository.
 *
 * Acquires a per-repo lock, checks mergeability for each candidate,
 * and for conflicting PRs enqueues a cloud task to resolve conflicts.
 * Falls back to posting a failure comment if no Fixer agent is found
 * or if enqueueing fails.
 *
 * @returns The number of PRs that were found to be conflicting.
 */
export async function processConflictCandidates(
  octokit: OctokitClient,
  redis: RedisClient,
  candidates: ConflictCandidate[],
  context: ProcessCandidatesContext,
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }

  const { owner, repo } = candidates[0]!;
  const repoFullName = `${owner}/${repo}`;

  // Acquire per-repo concurrency lock
  const releaseLock = await acquireRepoLock(redis, owner, repo);

  if (!releaseLock) {
    // Another run is in progress for this repo — skip
    return 0;
  }

  let conflictingCount = 0;

  try {
    for (const candidate of candidates) {
      console.log(
        `${LOG_PREFIX} Checking mergeability for ${repoFullName}#${candidate.prNumber}`,
      );

      const result = await pollMergeability(
        octokit,
        owner,
        repo,
        candidate.prNumber,
        // Use a limited number of retries within a single processing run
        3,
      );

      if (result.status === 'conflicting') {
        conflictingCount++;

        console.log(
          `${LOG_PREFIX} PR ${repoFullName}#${candidate.prNumber} has conflicts — attempting resolution`,
        );

        // Check for existing active resolution job (dedup guard)
        const alreadyActive = await hasActiveResolutionJob(
          repoFullName,
          candidate.prNumber,
        );

        if (alreadyActive) {
          continue;
        }

        const activeBranchWork = await findActiveGitHubBranchWork({
          repoFullName,
          prNumber: candidate.prNumber,
          branchName: candidate.headRef,
        });

        if (activeBranchWork) {
          console.log(
            `${LOG_PREFIX} Skipping ${repoFullName}#${candidate.prNumber} — active ${PRODUCT_NAME} job ${activeBranchWork.jobId} (${activeBranchWork.type}, match=${activeBranchWork.match}) is still working on the branch`,
          );
          continue;
        }

        const latestCommitAt = await getCommitCommittedAt({
          octokit,
          owner: candidate.headRepoOwner,
          repo: candidate.headRepoName,
          ref: candidate.headSha,
        });

        if (!latestCommitAt) {
          console.warn(
            `${LOG_PREFIX} Skipping ${repoFullName}#${candidate.prNumber} — could not determine head commit timestamp for ${candidate.headSha}`,
          );
          continue;
        }

        if (hasRecentGitHubBranchCommit({ latestCommitAt })) {
          console.log(
            `${LOG_PREFIX} Skipping ${repoFullName}#${candidate.prNumber} — head branch had a recent commit at ${latestCommitAt.toISOString()} (idle window ${Math.round(DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS / 60_000)}m)`,
          );
          continue;
        }

        // Try to enqueue a cloud task for conflict resolution
        const enqueued = await tryEnqueueResolution(
          octokit,
          candidate,
          repoFullName,
          context,
        );

        if (!enqueued) {
          await postTaskStartFailureComment(
            octokit,
            owner,
            repo,
            candidate.prNumber,
          );
        }
      } else if (result.status === 'clean') {
        console.log(
          `${LOG_PREFIX} PR ${repoFullName}#${candidate.prNumber} is clean — no action needed`,
        );
      } else {
        console.warn(
          `${LOG_PREFIX} Could not determine mergeability for ${repoFullName}#${candidate.prNumber} — skipping`,
        );
      }
    }
  } finally {
    await releaseLock();
  }

  console.log(
    `${LOG_PREFIX} Processed ${candidates.length} candidates for ${repoFullName}: ${conflictingCount} conflicting`,
  );

  return conflictingCount;
}

/**
 * Attempt to resolve conflicts by enqueueing a cloud task via a Fixer agent.
 *
 * @returns `true` if at least one cloud task was enqueued, `false` otherwise.
 */
async function tryEnqueueResolution(
  octokit: OctokitClient,
  candidate: ConflictCandidate,
  repoFullName: string,
  context: ProcessCandidatesContext,
): Promise<boolean> {
  try {
    // Use the PR author as the "sender" so that automation target resolution maps
    // the correct userId via githubUserMappings — matching the pattern
    // used by PR reviewer and issue fixer tasks.
    const sender = {
      login: candidate.authorLogin,
      id: candidate.authorId,
    } as WebhookUser;

    const targetResult = await getGitHubAutomationTargets({
      type: CloudAgentType.Fixer,
      installation: context.installation,
      repository: context.repository,
      sender,
      author: candidate.authorLogin.toLowerCase(),
    });

    if (targetResult.status !== 'ok' || targetResult.targets.length === 0) {
      console.log(
        `${LOG_PREFIX} No Fixer targets found for ${repoFullName} — falling back to comment`,
      );
      return false;
    }

    const { owner, repo } = candidate;

    for (const target of targetResult.targets) {
      const launchResult = await enqueueTask({
        task: {
          type: TaskPayloadKind.GithubPrConflictResolve,
          ...getBackgroundGithubTaskProperties(target.properties),
          payload: {
            repo: repoFullName,
            prNumber: candidate.prNumber,
            prTitle: candidate.title,
            prUrl: candidate.htmlUrl,
            headRef: candidate.headRef,
            baseRef: candidate.baseRef,
          },
        },
        initiator: {
          kind: 'automation',
          key: 'conflict_resolver',
          actor: {
            externalId: String(candidate.authorId),
            displayName: candidate.authorLogin,
          },
        },
        workflow: 'pr_conflict_resolve',
        surface: 'github',
        trigger: 'webhook',
        prLinkage: {
          provider: 'github',
          repository: repoFullName,
          prNumber: candidate.prNumber,
          prUrl: candidate.htmlUrl,
          prTitle: candidate.title,
          prSha: candidate.headSha,
          prBaseRef: candidate.baseRef,
        },
      });

      const taskUrl = getTaskUrl({
        taskId: launchResult.taskId,
        utm: {
          source: 'github',
          campaign: 'conflict-resolution',
        },
      });
      const launchTarget = `cloud job ${launchResult.id}`;

      console.log(
        `${LOG_PREFIX} Launched conflict resolution ${launchTarget} for ${repoFullName}#${candidate.prNumber} (target ${target.id})`,
      );

      await postWorkingOnItComment(
        octokit,
        owner,
        repo,
        candidate.prNumber,
        taskUrl,
      );
    }

    return true;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to enqueue resolution for ${repoFullName}#${candidate.prNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
