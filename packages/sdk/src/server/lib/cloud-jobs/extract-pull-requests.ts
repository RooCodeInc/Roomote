import {
  db,
  cloudJobs,
  taskPullRequests,
  and,
  eq,
  sql,
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
 * 3. Updates the `cloudJobs` row with `prRepo`, `prNumber`, and the
 *    PR base ref so the association is visible in the dashboard.
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
  // Load the full cloud job to get installation context for GitHub API.
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
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
    })
    .onConflictDoUpdate({
      target: [taskPullRequests.taskId, taskPullRequests.prUrl],
      set: {
        sourceControlProvider: 'github',
        host: 'github.com',
        ...(linkedRepository && { repositoryId: linkedRepository.id }),
        ...(prTitle !== null && { prTitle }),
        ...(status !== null && { status }),
        updatedAt: new Date(),
      },
    });

  // The persisted base must always belong to the PR recorded alongside it. A
  // job can have more than one PR detected over its life, and envelopes can be
  // processed concurrently:
  //  - fetch succeeded → write the fresh base.
  //  - fetch failed → keep the base only if the row STILL points at this PR,
  //    else clear it. The same-PR check is done against the live row inside the
  //    UPDATE (not the snapshot read before the async fetch), so a concurrent
  //    update that flipped the row to a different PR can't leave that PR's base
  //    stranded under this PR's repo/number.
  const rowStillPointsAtThisPr = sql`${cloudJobs.prRepo} = ${pr.repository} AND ${cloudJobs.prNumber} = ${pr.number}`;

  await db
    .update(cloudJobs)
    .set({
      prSourceControlProvider: 'github',
      prRepo: pr.repository,
      prNumber: pr.number,
      prBaseRef: fetchedPrDetails
        ? baseRef
        : sql`CASE WHEN ${rowStillPointsAtThisPr} THEN ${cloudJobs.prBaseRef} ELSE NULL END`,
      prBaseSha: fetchedPrDetails
        ? baseSha
        : sql`CASE WHEN ${rowStillPointsAtThisPr} THEN ${cloudJobs.prBaseSha} ELSE NULL END`,
    })
    .where(eq(cloudJobs.id, cloudJobId));
}
