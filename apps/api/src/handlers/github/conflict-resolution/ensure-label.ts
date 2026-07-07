import { PRODUCT_NAME } from '@roomote/types';

import type { OctokitClient } from './types';

import { AUTO_RESOLVE_CONFLICTS_LABEL, LOG_PREFIX } from './constants';

/**
 * Ensure the auto-resolve conflicts label exists on a repository.
 *
 * Creates the label if it doesn't exist. Failures are logged but never
 * thrown — label creation is best-effort so it doesn't block PR creation.
 */
export async function ensureConflictLabel(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  conflictResolverLabel: string = AUTO_RESOLVE_CONFLICTS_LABEL,
): Promise<boolean> {
  try {
    await octokit.rest.issues.getLabel({
      owner,
      repo,
      name: conflictResolverLabel,
    });

    return true;
  } catch (error: unknown) {
    // Label doesn't exist — create it
    const statusCode =
      error && typeof error === 'object' && 'status' in error
        ? (error as { status: number }).status
        : undefined;

    if (statusCode !== 404) {
      console.warn(
        `${LOG_PREFIX} Unexpected error checking label on ${owner}/${repo}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  try {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: conflictResolverLabel,
      color: '6f42c1', // Purple
      description: `${PRODUCT_NAME} will automatically resolve merge conflicts on this PR`,
    });

    console.log(
      `${LOG_PREFIX} Created label "${conflictResolverLabel}" on ${owner}/${repo}`,
    );

    return true;
  } catch (createError) {
    console.warn(
      `${LOG_PREFIX} Failed to create label on ${owner}/${repo}:`,
      createError instanceof Error ? createError.message : createError,
    );
    return false;
  }
}

/**
 * Add the auto-resolve conflicts label to a PR.
 *
 * Best-effort — failures are logged but never thrown.
 */
export async function addConflictLabelToPr(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  conflictResolverLabel: string = AUTO_RESOLVE_CONFLICTS_LABEL,
): Promise<boolean> {
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [conflictResolverLabel],
    });

    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to add label to ${owner}/${repo}#${prNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
