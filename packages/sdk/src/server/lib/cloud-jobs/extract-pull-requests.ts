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
import type { PullRequestStatus, SourceControlProvider } from '@roomote/types';
import type { ParsedPR } from '../../../pull-request-links';
import { readSourceControlPullRequestForCloudJob } from '../pull-requests/source-control-pull-request-reads';

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
async function fetchGitHubPrDetails(
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

function mapProviderReadStatus(details: {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
}): PullRequestStatus {
  if (details.state === 'merged') {
    return 'merged';
  }

  if (details.state === 'closed') {
    return 'closed';
  }

  if (details.draft) {
    return 'draft';
  }

  return 'open';
}

/**
 * Fetches title/status/base metadata for a detected PR URL. GitHub keeps the
 * installation-token path (works even when the repo row is unlinked). Other
 * providers reuse the multi-provider read surface, which owns token resolution
 * and status mapping.
 */
async function fetchDetectedPrDetails(
  cloudJob: CloudJob,
  pr: ParsedPR,
): Promise<{
  title: string;
  status: PullRequestStatus;
  baseRef: string | null;
  baseSha: string | null;
} | null> {
  if (pr.provider === 'github') {
    const [owner, repoName] = pr.repository.split('/');

    if (!owner || !repoName) {
      return null;
    }

    return fetchGitHubPrDetails(cloudJob, owner, repoName, pr.number);
  }

  try {
    const result = await readSourceControlPullRequestForCloudJob({
      cloudJob,
      input: {
        action: 'get_pull_request',
        repositoryFullName: pr.repository,
        prNumber: pr.number,
        sourceControlProvider: pr.provider,
      },
    });

    if (!('title' in result)) {
      return null;
    }

    return {
      title: result.title,
      status: mapProviderReadStatus(result),
      baseRef: result.targetBranch || null,
      baseSha: result.baseSha,
    };
  } catch (error) {
    console.warn(
      `[fetchPrDetails] Failed to fetch details for ${pr.provider} ${pr.repository}#${pr.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

async function resolveLinkedRepository({
  provider,
  repositoryFullName,
}: {
  provider: SourceControlProvider;
  repositoryFullName: string;
}): Promise<{ id: string; host: string | null } | null> {
  const linkedRepository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, provider),
      eq(repositories.fullName, repositoryFullName),
    ),
    columns: { id: true, host: true },
  });

  return linkedRepository ?? null;
}

/**
 * Persists a detected pull request to the database:
 *
 * 1. Fetches the PR title/status from the matching source-control API when
 *    possible.
 * 2. Inserts into `task_pull_requests` (upsert via onConflictDoUpdate so the
 *    same PR URL for a given task is never duplicated).
 * 3. Updates the `cloudJobs` row with provider, `prRepo`, `prNumber`, and the
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
  // Load the full cloud job to get installation/token context for API lookups.
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
  });

  let prTitle: string | null = null;
  let status: PullRequestStatus | null = null;
  let baseRef: string | null = null;
  let baseSha: string | null = null;
  let fetchedPrDetails = false;

  if (cloudJob) {
    const details = await fetchDetectedPrDetails(cloudJob, pr);

    if (details) {
      fetchedPrDetails = true;
      prTitle = details.title;
      status = details.status;
      baseRef = details.baseRef;
      baseSha = details.baseSha;
    }
  }

  // Resolve the linked repository row by the provider decoded from the PR URL
  // (nullable when the repo isn't linked) so the provider-scoped FK is set for
  // new associations.
  const linkedRepository = await resolveLinkedRepository({
    provider: pr.provider,
    repositoryFullName: pr.repository,
  });
  // Prefer the host decoded from the PR URL so self-managed instances keep the
  // instance that produced the link, even when a linked row has no host yet.
  const host = pr.host || linkedRepository?.host || null;

  await db
    .insert(taskPullRequests)
    .values({
      taskId,
      sourceControlProvider: pr.provider,
      host,
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
        sourceControlProvider: pr.provider,
        host,
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
      prSourceControlProvider: pr.provider,
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
