import {
  db,
  taskPullRequests,
  taskRuns,
  and,
  eq,
  repositories,
} from '@roomote/db/server';
import type { CloudJob } from '@roomote/db/server';
import { createCloudJobGitHubToken, getOctokit } from '@roomote/github';
import type { PullRequestStatus } from '@roomote/types';
import type { ParsedPR } from '../../../pull-request-links';

export {
  detectPullRequestsFromToolResultEnvelope,
  parsePRFromOutput,
  parsePRsFromAuthoritativeToolResultOutput,
  parsePRsFromGhPrCheckoutToolResult,
  parsePRsFromGhPrCreateToolResult,
  parsePRsFromGhPrListToolResult,
  parsePRsFromText,
} from '../../../pull-request-links';

/**
 * Fetches the PR title, status, and base branch from the GitHub API using the
 * cloud job's installation token. Returns `null` on any failure so callers can
 * degrade gracefully. The base ref and sha are persisted alongside the PR
 * association as cloud-job PR metadata.
 */
async function fetchPrDetails(
  cloudJob: CloudJob,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{
  title: string;
  status: PullRequestStatus;
  baseRef: string | null;
  baseSha: string | null;
} | null> {
  try {
    const token = await createCloudJobGitHubToken(cloudJob);
    const octokit = getOctokit(token);

    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    let status: PullRequestStatus;

    if (data.merged) {
      status = 'merged';
    } else if (data.state === 'closed') {
      status = 'closed';
    } else if (data.draft) {
      status = 'draft';
    } else {
      status = 'open';
    }

    return {
      title: data.title,
      status,
      baseRef: data.base.ref || null,
      baseSha: data.base.sha || null,
    };
  } catch (error) {
    console.warn(
      `[fetchPrDetails] Failed to fetch details for ${owner}/${repo}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

/**
 * Persists a detected pull request to the database:
 *
 * 1. Fetches the PR title from the GitHub API.
 * 2. Inserts into `task_pull_requests` (upsert via onConflictDoNothing
 *    so the same PR URL for a given task is never duplicated).
 * 3. Persists the PR base ref/sha on the `task_pull_requests` row itself —
 *    task_pull_requests is the only PR home; runs carry no PR columns.
 */
export async function persistDetectedPullRequest({
  taskId,
  cloudJobId,
  pr,
}: {
  taskId: string;
  cloudJobId: number;
  pr: ParsedPR;
}): Promise<void> {
  // Load the full run to get installation context for GitHub API.
  const cloudJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, cloudJobId),
  });

  const [owner, repoName] = pr.repository.split('/');
  let prTitle: string | null = null;
  let status: PullRequestStatus | null = null;
  let baseRef: string | null = null;
  let baseSha: string | null = null;
  let fetchedPrDetails = false;

  if (cloudJob && owner && repoName) {
    const details = await fetchPrDetails(cloudJob, owner, repoName, pr.number);

    if (details) {
      fetchedPrDetails = true;
      prTitle = details.title;
      status = details.status;
      baseRef = details.baseRef;
      baseSha = details.baseSha;
    }
  }

  // The transcript parser only emits canonical https://github.com/... PR URLs,
  // so detected PRs are GitHub rows by construction. Resolve the linked
  // repository row (nullable when the repo isn't linked) so the
  // provider-scoped FK is set for new associations.
  const linkedRepository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'github'),
      eq(repositories.fullName, pr.repository),
    ),
    columns: { id: true },
  });

  await db
    .insert(taskPullRequests)
    .values({
      taskId,
      sourceControlProvider: 'github',
      host: 'github.com',
      repositoryId: linkedRepository?.id ?? null,
      prUrl: pr.url,
      prNumber: pr.number,
      prTitle,
      repository: pr.repository,
      status,
      prBaseRef: baseRef,
      prBaseSha: baseSha,
    })
    .onConflictDoUpdate({
      target: [taskPullRequests.taskId, taskPullRequests.prUrl],
      set: {
        sourceControlProvider: 'github',
        host: 'github.com',
        ...(linkedRepository && { repositoryId: linkedRepository.id }),
        ...(prTitle !== null && { prTitle }),
        ...(status !== null && { status }),
        ...(fetchedPrDetails && { prBaseRef: baseRef, prBaseSha: baseSha }),
        updatedAt: new Date(),
      },
    });
}
