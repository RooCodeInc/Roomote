import {
  CONFLICT_RESOLUTION_COMMENT_MARKER,
  formatConflictResolutionFailureComment,
  formatConflictResolutionSuccessComment,
  type ConflictResolutionSummary,
} from '@roomote/types';
import type { OctokitClient } from './types';

import { LOG_PREFIX } from './constants';

/**
 * Post a "working on it" comment on a PR when conflicts are detected
 * and a resolution task has been enqueued.
 *
 * Returns the comment ID so callers can reference it later, or `null`
 * if posting failed (non-fatal — the resolution task still runs).
 */
export async function postWorkingOnItComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  taskUrl?: string,
): Promise<number | null> {
  const body = [
    CONFLICT_RESOLUTION_COMMENT_MARKER,
    taskUrl
      ? `I see some merge conflicts here. [Working on them now...](${taskUrl})`
      : 'I see some merge conflicts here. I queued work to resolve them.',
  ].join('\n');

  try {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    console.log(
      `${LOG_PREFIX} Posted "working on it" comment on ${owner}/${repo}#${prNumber} (comment ${data.id})`,
    );

    return data.id;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to post "working on it" comment on ${owner}/${repo}#${prNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

interface ConflictResolutionFailure {
  /** Short reason for the failure. */
  reason: string;
  /** Whether the failure is due to a high-severity review finding. */
  isReviewBlock: boolean;
}

/**
 * Post a top-level comment on a PR summarizing a successful conflict resolution.
 *
 * Only posts when there's actual content to report (action taken).
 */
export async function postResolutionComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  summary: ConflictResolutionSummary,
): Promise<void> {
  const body = formatConflictResolutionSuccessComment(summary);

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    console.log(
      `${LOG_PREFIX} Posted resolution comment on ${owner}/${repo}#${prNumber}`,
    );
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to post resolution comment on ${owner}/${repo}#${prNumber}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Post a top-level comment explaining that conflict resolution failed
 * and human intervention is needed.
 */
export async function postFailureComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  failure: ConflictResolutionFailure,
): Promise<void> {
  const body = formatConflictResolutionFailureComment(failure.reason);

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    console.log(
      `${LOG_PREFIX} Posted failure comment on ${owner}/${repo}#${prNumber}`,
    );
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to post failure comment on ${owner}/${repo}#${prNumber}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function postTaskStartFailureComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: 'I detected merge conflicts but could not start a task to address them.',
    });

    console.log(
      `${LOG_PREFIX} Posted task-start failure comment on ${owner}/${repo}#${prNumber}`,
    );
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to post task-start failure comment on ${owner}/${repo}#${prNumber}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
