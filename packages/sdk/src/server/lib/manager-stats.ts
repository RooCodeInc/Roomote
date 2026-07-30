import * as GitHub from '@roomote/github';
import {
  formatAutomationLabel,
  type SourceControlProvider,
} from '@roomote/types';

import {
  db,
  repositories,
  taskPullRequests,
  tasks,
  users,
  eq,
  gte,
} from '@roomote/db/server';

import {
  listMergedSourceControlPullRequestsForRepository,
  listOpenSourceControlPullRequestsForRepository,
  type SourceControlPullRequestSummary,
} from './pull-requests/source-control-pull-request-reads';
import type { RepositoryRow } from './pull-requests/source-control-pull-request-shared';

const LOG_PREFIX = '[managerStats]';

/**
 * Cap on PRs fetched per non-GitHub repository per list state in one digest
 * computation. Matches the provider-neutral list primitive's maximum.
 */
const SOURCE_CONTROL_ANALYTICS_LIST_LIMIT = 200;

type TaskInitiatorRow = {
  initiatorKind: 'user' | 'automation';
  initiatorUserId: string | null;
  initiatorAutomation: string | null;
  actorExternalId: string | null;
  actorDisplayName: string | null;
  userName: string | null;
  userEmail: string | null;
};

/**
 * Human-readable label for a task's initiator. Automation tasks are labeled
 * by their automation key; user tasks by the linked user's name/email or the
 * frozen external actor display.
 */
function getInitiatorLabel(row: TaskInitiatorRow): string {
  if (row.initiatorKind === 'automation') {
    // Match the web dashboard/analytics label formatting so an automation is
    // named consistently across surfaces. Custom automations prefer the
    // user-entered name stamped as actorDisplayName.
    return row.initiatorAutomation
      ? formatAutomationLabel(row.initiatorAutomation, {
          actorDisplayName: row.actorDisplayName,
        })
      : 'automation';
  }

  return (
    row.userName ??
    row.userEmail ??
    row.actorDisplayName ??
    row.actorExternalId ??
    'Unknown user'
  );
}

/**
 * How a Roomote-linked PR relates to Roomote:
 * - `authored`: a Roomote task produced this PR (any workflow other than
 *   `pr_review`), or it was opened directly by the Roomote bot account.
 * - `reviewed`: Roomote reviewed someone else's PR (a `pr_review` task row).
 */
export type PullRequestClassification = 'authored' | 'reviewed';

export type PullRequestMetadata = {
  canonicalTaskId: string;
  userLabel: string;
  initiatorKind: TaskInitiatorRow['initiatorKind'];
  classification: PullRequestClassification;
};

type PullRequestMetadataRow = TaskInitiatorRow & {
  taskId: string;
  sourceControlProvider: SourceControlProvider;
  repository: string | null;
  prNumber: number | null;
  workflow: string | null;
};

export type ManagerStatsDigest = {
  activeUsers: number;
  roomotePullRequests: number;
  authoredPullRequests: number;
  reviewedPullRequests: number;
  totalPullRequests: number;
  roomotePullRequestPercentage: number;
  mergedRoomotePullRequests: number;
  mergedRoomotePullRequestPercentage: number;
  additions: number;
  deletions: number;
  /**
   * Which Roomote PRs `additions`/`deletions` cover. Line counts come from
   * the GitHub PR-details API and no equivalent bulk surface exists on the
   * other providers (each would need its own diff-stat endpoint), so when
   * non-GitHub Roomote PRs are in the digest the LOC numbers are partial and
   * the digest omits its LOC line instead of silently undercounting.
   */
  locScope: 'all' | 'github_only';
  mostActiveRepo: {
    /**
     * Bare repository full name. PR counts behind it are provider-qualified,
     * so equally named repositories on different providers never combine
     * into one count.
     */
    fullName: string;
    pullRequestCount: number;
  } | null;
  topUsers: Array<{
    label: string;
    pullRequestCount: number;
  }>;
};

/**
 * PR identity is provider-qualified: `(repository full name, number)` pairs
 * can collide across providers (e.g. a mirrored `owner/repo#1` on GitHub and
 * GitLab), and taskPullRequests stamps the provider on every association.
 */
function getPullRequestKey(
  provider: SourceControlProvider,
  repoFullName: string,
  prNumber: number,
) {
  return `${provider}:${repoFullName.toLowerCase()}#${prNumber}`;
}

/**
 * A `pr_review` task reviewed someone else's PR; any other workflow means the
 * task produced (authored) the PR.
 */
function classifyWorkflow(workflow: string | null): PullRequestClassification {
  return workflow === 'pr_review' ? 'reviewed' : 'authored';
}

function isRoomoteGitHubPullRequestAuthor(login: string | null) {
  if (!login) {
    return false;
  }

  const normalizedLogin = login.trim().toLowerCase();

  return GitHub.Schemas.isRoomoteGitHubLogin(normalizedLogin);
}

/**
 * Fold task/PR rows into per-PR metadata, keyed by provider:repo#number.
 *
 * A single PR key can appear with rows from both an authoring task and a
 * review task. `authored` always wins: Roomote making the PR is not demoted by
 * a later review of that same PR. Among rows of the same classification the
 * first seen wins.
 */
export function buildRoomotePullRequestMetadata(
  rows: PullRequestMetadataRow[],
): Map<string, PullRequestMetadata> {
  const metadataByKey = new Map<string, PullRequestMetadata>();

  for (const row of rows) {
    if (!row.repository || row.prNumber === null) {
      continue;
    }

    const key = getPullRequestKey(
      row.sourceControlProvider,
      row.repository,
      row.prNumber,
    );
    const classification = classifyWorkflow(row.workflow);
    const existing = metadataByKey.get(key);

    if (existing) {
      // Keep an existing `authored` classification (authored wins), and keep
      // the first-seen row when both share a classification.
      if (
        existing.classification === 'authored' ||
        classification === 'reviewed'
      ) {
        continue;
      }
    }

    metadataByKey.set(key, {
      canonicalTaskId: row.taskId,
      userLabel: getInitiatorLabel(row),
      initiatorKind: row.initiatorKind,
      classification,
    });
  }

  return metadataByKey;
}

async function getRoomotePullRequestMetadataByKey() {
  const results = await db
    .select({
      taskId: taskPullRequests.taskId,
      sourceControlProvider: taskPullRequests.sourceControlProvider,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      workflow: tasks.workflow,
      initiatorKind: tasks.initiatorKind,
      initiatorUserId: tasks.initiatorUserId,
      initiatorAutomation: tasks.initiatorAutomation,
      actorExternalId: tasks.actorExternalId,
      actorDisplayName: tasks.actorDisplayName,
      userName: users.name,
      userEmail: users.email,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .leftJoin(users, eq(users.id, tasks.initiatorUserId));

  return buildRoomotePullRequestMetadata(results);
}

async function getAnalyticsRepositories(): Promise<RepositoryRow[]> {
  return db.query.repositories.findMany({
    where: eq(repositories.isActive, true),
    columns: {
      id: true,
      sourceControlProvider: true,
      host: true,
      installationId: true,
      externalRepoId: true,
      fullName: true,
      htmlUrl: true,
    },
  });
}

async function getActiveUserCount(since: Date) {
  const rows = await db
    .select({
      initiatorKind: tasks.initiatorKind,
      initiatorUserId: tasks.initiatorUserId,
      actorExternalId: tasks.actorExternalId,
    })
    .from(tasks)
    .where(gte(tasks.createdAt, since));

  const humanCreatorKeys = rows.flatMap((row) => {
    if (row.initiatorKind !== 'user') {
      return [];
    }

    if (row.initiatorUserId) {
      return [`user:${row.initiatorUserId}`];
    }

    return row.actorExternalId ? [`external:${row.actorExternalId}`] : [];
  });

  return new Set(humanCreatorKeys).size;
}

/**
 * The provider-neutral analytics shape the digest is computed from: one row
 * per PR created inside the stats window, from any source-control provider.
 */
export type AnalyticsPullRequest = {
  sourceControlProvider: SourceControlProvider;
  repoFullName: string;
  number: number;
  state: string;
  authorLogin: string | null;
};

type ClassifiedPullRequest = {
  pullRequest: AnalyticsPullRequest;
  classification: PullRequestClassification;
};

/**
 * Map provider-neutral list summaries (open + merged) to the analytics shape,
 * keeping only PRs created inside the stats window. Rows without a created
 * timestamp are dropped: window membership cannot be confirmed, and counting
 * a PR of unknown age would inflate the weekly totals. Summaries are deduped
 * by PR number, preferring the merged summary on a collision: the open and
 * merged lists are fetched concurrently, so a PR that merges between the two
 * requests can appear in both, and keeping the stale open row would
 * underreport merged counts.
 */
export function toAnalyticsPullRequests({
  provider,
  repoFullName,
  summaries,
  since,
}: {
  provider: SourceControlProvider;
  repoFullName: string;
  summaries: SourceControlPullRequestSummary[];
  since: Date;
}): AnalyticsPullRequest[] {
  const byNumber = new Map<number, AnalyticsPullRequest>();

  for (const summary of summaries) {
    if (!summary.createdAt || new Date(summary.createdAt) < since) {
      continue;
    }

    const existing = byNumber.get(summary.number);

    if (
      existing &&
      (existing.state === 'merged' || summary.state !== 'merged')
    ) {
      continue;
    }

    byNumber.set(summary.number, {
      sourceControlProvider: provider,
      repoFullName,
      number: summary.number,
      // Match the GitHub analytics state vocabulary, where an open draft PR
      // is reported as 'draft'.
      state:
        summary.state === 'open' && summary.draft ? 'draft' : summary.state,
      authorLogin: summary.author?.login ?? null,
    });
  }

  return [...byNumber.values()];
}

/**
 * PRs created in the window for one non-GitHub repository, via the
 * provider-neutral open/merged list primitives.
 *
 * Known degradation: the list primitive supports the open and merged states
 * only, so PRs that were closed without merging inside the window are not
 * counted for non-GitHub repositories (the GitHub path counts them). That
 * slightly undercounts `totalPullRequests` on those providers; it never
 * fabricates activity.
 */
async function listSourceControlAnalyticsPullRequests({
  repository,
  since,
}: {
  repository: RepositoryRow;
  since: Date;
}): Promise<AnalyticsPullRequest[]> {
  const provider = repository.sourceControlProvider;

  // A PR merged in the window was necessarily updated in the window, so
  // updatedAfter bounds the merged list to a superset of the created-after
  // filter applied below.
  const [openResult, mergedResult] = await Promise.all([
    listOpenSourceControlPullRequestsForRepository({
      repository,
      provider,
      limit: SOURCE_CONTROL_ANALYTICS_LIST_LIMIT,
    }),
    listMergedSourceControlPullRequestsForRepository({
      repository,
      provider,
      limit: SOURCE_CONTROL_ANALYTICS_LIST_LIMIT,
      updatedAfter: since,
    }),
  ]);

  // The list primitives report degradation (most importantly truncation at
  // the list cap, which undercounts a busy repository's window totals) via
  // warnings; log every one per repository instead of silently dropping them.
  for (const warning of [...openResult.warnings, ...mergedResult.warnings]) {
    console.warn(
      `${LOG_PREFIX} ${provider} pull request list warning for ${repository.fullName}: ${warning}`,
    );
  }

  return toAnalyticsPullRequests({
    provider,
    repoFullName: repository.fullName,
    summaries: [...openResult.pullRequests, ...mergedResult.pullRequests],
    since,
  });
}

/** Exported for tests. */
export async function getSourceControlAnalyticsPullRequests({
  repositoryRows,
  since,
}: {
  repositoryRows: RepositoryRow[];
  since: Date;
}): Promise<AnalyticsPullRequest[]> {
  const results: AnalyticsPullRequest[] = [];

  for (const repository of repositoryRows) {
    try {
      results.push(
        ...(await listSourceControlAnalyticsPullRequests({
          repository,
          since,
        })),
      );
    } catch (error) {
      // One unreachable repository must not sink the whole digest; its PRs
      // are simply missing from this week's counts.
      console.warn(
        `${LOG_PREFIX} Failed to list ${repository.sourceControlProvider} pull requests for ${repository.fullName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return results;
}

async function getGitHubAnalyticsPullRequests({
  actorUserId,
  repositoryIds,
  since,
}: {
  actorUserId: string | null;
  repositoryIds: string[];
  since: Date;
}): Promise<AnalyticsPullRequest[]> {
  if (repositoryIds.length === 0) {
    return [];
  }

  if (!actorUserId) {
    // GitHub repositories only exist under an installation, and eligible
    // deployments resolve an actor from that installation, so this is a
    // defensive guard rather than an expected path.
    console.warn(
      `${LOG_PREFIX} Skipping ${repositoryIds.length} GitHub repositories: no GitHub actor is available.`,
    );
    return [];
  }

  // isRoomoteGitHubPullRequestAuthor classifies logins synchronously from the
  // cached configured app slug.
  await GitHub.resolveConfiguredGitHubAppSlug();

  const items = await GitHub.getPullRequestsForAnalytics({
    userId: actorUserId,
    repositoryIds,
    createdAfter: since,
  });

  return items.map((item) => ({
    sourceControlProvider: 'github' as const,
    repoFullName: item.repoFullName,
    number: item.number,
    state: item.state,
    authorLogin: item.authorLogin,
  }));
}

/**
 * Filter the analytics PRs down to Roomote-linked ones and classify each as
 * authored or reviewed.
 *
 * A PR reaches here if it has task metadata OR (on GitHub) was opened by the
 * Roomote bot account. `authored` wins whenever any authored signal is
 * present: an authoring task row (`metadata.classification === 'authored'`)
 * or a bot-authored PR, even if a `pr_review` task also touched it. A PR is
 * only `reviewed` when its metadata is a review row and Roomote is not the PR
 * author.
 *
 * Bot-login matching is GitHub-only: the other providers act through a plain
 * access token whose user is deployment-specific, and every PR Roomote opens
 * there comes from a task, so the task linkage already covers them.
 */
export function summarizeRoomotePullRequests({
  pullRequests,
  metadataByKey,
}: {
  pullRequests: AnalyticsPullRequest[];
  metadataByKey: Map<string, PullRequestMetadata>;
}) {
  const roomotePullRequests: ClassifiedPullRequest[] = [];

  for (const pullRequest of pullRequests) {
    const metadata = metadataByKey.get(
      getPullRequestKey(
        pullRequest.sourceControlProvider,
        pullRequest.repoFullName,
        pullRequest.number,
      ),
    );
    const isAuthorMatch =
      pullRequest.sourceControlProvider === 'github' &&
      isRoomoteGitHubPullRequestAuthor(pullRequest.authorLogin);

    if (!metadata && !isAuthorMatch) {
      continue;
    }

    const classification: PullRequestClassification =
      !metadata || metadata.classification === 'authored' || isAuthorMatch
        ? 'authored'
        : 'reviewed';

    roomotePullRequests.push({ pullRequest, classification });
  }

  const authored = roomotePullRequests.filter(
    (entry) => entry.classification === 'authored',
  );
  const reviewed = roomotePullRequests.filter(
    (entry) => entry.classification === 'reviewed',
  );
  const mergedAuthored = authored.filter(
    (entry) => entry.pullRequest.state === 'merged',
  );

  return { roomotePullRequests, authored, reviewed, mergedAuthored };
}

/**
 * The repository with the most counted Roomote PRs. Counting is
 * provider-qualified so equally named repositories on different providers
 * (e.g. a mirrored `org/repo` on GitHub and GitLab) are never combined into
 * one wrong count; the reported label is the bare full name of the single
 * winning repository.
 */
export function computeMostActiveRepo(
  pullRequests: AnalyticsPullRequest[],
): ManagerStatsDigest['mostActiveRepo'] {
  const repoCounts = new Map<
    string,
    {
      fullName: string;
      pullRequestCount: number;
    }
  >();

  for (const pullRequest of pullRequests) {
    const key = `${pullRequest.sourceControlProvider}:${pullRequest.repoFullName.toLowerCase()}`;
    const existing = repoCounts.get(key);

    if (existing) {
      existing.pullRequestCount += 1;
    } else {
      repoCounts.set(key, {
        fullName: pullRequest.repoFullName,
        pullRequestCount: 1,
      });
    }
  }

  return (
    [...repoCounts.entries()].sort(([leftKey, left], [rightKey, right]) => {
      if (right.pullRequestCount !== left.pullRequestCount) {
        return right.pullRequestCount - left.pullRequestCount;
      }

      // Same-name repos on different providers tie on fullName too; the
      // provider-qualified key keeps the selection deterministic.
      return leftKey.localeCompare(rightKey);
    })[0]?.[1] ?? null
  );
}

export function computeTopUsers(
  pullRequests: AnalyticsPullRequest[],
  metadataByKey: Map<string, PullRequestMetadata>,
): ManagerStatsDigest['topUsers'] {
  const userCounts = new Map<string, number>();

  for (const pullRequest of pullRequests) {
    const metadata = metadataByKey.get(
      getPullRequestKey(
        pullRequest.sourceControlProvider,
        pullRequest.repoFullName,
        pullRequest.number,
      ),
    );

    if (metadata?.initiatorKind !== 'user') {
      continue;
    }

    userCounts.set(
      metadata.userLabel,
      (userCounts.get(metadata.userLabel) ?? 0) + 1,
    );
  }

  return [...userCounts.entries()]
    .map(([label, pullRequestCount]) => ({
      label,
      pullRequestCount,
    }))
    .sort((left, right) => {
      if (right.pullRequestCount !== left.pullRequestCount) {
        return right.pullRequestCount - left.pullRequestCount;
      }

      return left.label.localeCompare(right.label);
    })
    .slice(0, 5);
}

export async function buildManagerStatsDigest(params: {
  /**
   * User the GitHub API calls run as. Only needed for the GitHub data path;
   * null on deployments without a GitHub installation (their GitHub repo set
   * is empty).
   */
  actorUserId: string | null;
  since: Date;
}) {
  const repositoryRows = await getAnalyticsRepositories();

  if (repositoryRows.length === 0) {
    return {
      activeUsers: await getActiveUserCount(params.since),
      roomotePullRequests: 0,
      authoredPullRequests: 0,
      reviewedPullRequests: 0,
      totalPullRequests: 0,
      roomotePullRequestPercentage: 0,
      mergedRoomotePullRequests: 0,
      mergedRoomotePullRequestPercentage: 0,
      additions: 0,
      deletions: 0,
      locScope: 'all',
      mostActiveRepo: null,
      topUsers: [],
    } satisfies ManagerStatsDigest;
  }

  const githubRepositoryIds = repositoryRows
    .filter((repository) => repository.sourceControlProvider === 'github')
    .map((repository) => repository.id);
  const sourceControlRepositories = repositoryRows.filter(
    (repository) => repository.sourceControlProvider !== 'github',
  );

  const [githubPullRequests, sourceControlPullRequests, metadataByKey] =
    await Promise.all([
      getGitHubAnalyticsPullRequests({
        actorUserId: params.actorUserId,
        repositoryIds: githubRepositoryIds,
        since: params.since,
      }),
      getSourceControlAnalyticsPullRequests({
        repositoryRows: sourceControlRepositories,
        since: params.since,
      }),
      getRoomotePullRequestMetadataByKey(),
    ]);

  const pullRequests = [...githubPullRequests, ...sourceControlPullRequests];

  const {
    roomotePullRequests: classifiedPullRequests,
    authored,
    reviewed,
    mergedAuthored,
  } = summarizeRoomotePullRequests({ pullRequests, metadataByKey });

  const roomotePullRequests = classifiedPullRequests.map(
    (entry) => entry.pullRequest,
  );
  // A merged PR that Roomote merely reviewed is not Roomote's merge outcome, so
  // merged stats are scoped to authored PRs only.
  const mergedRoomotePullRequests = mergedAuthored.map(
    (entry) => entry.pullRequest,
  );

  let additions = 0;
  let deletions = 0;

  // Line counts come from the GitHub PR-details API; the other providers
  // expose no comparable field on their PR payloads, so LOC covers GitHub
  // PRs only and `locScope` flags the gap for the digest line.
  const githubRoomotePullRequests = roomotePullRequests.filter(
    (pullRequest) => pullRequest.sourceControlProvider === 'github',
  );
  const locScope: ManagerStatsDigest['locScope'] =
    githubRoomotePullRequests.length === roomotePullRequests.length
      ? 'all'
      : 'github_only';

  if (params.actorUserId) {
    for (const pullRequest of githubRoomotePullRequests) {
      const [owner, repo] = pullRequest.repoFullName.split('/');

      if (!owner || !repo) {
        continue;
      }

      try {
        const details = await GitHub.getPullRequest({
          userId: params.actorUserId,
          owner,
          repo,
          prNumber: pullRequest.number,
        });

        if (!details.success) {
          continue;
        }

        additions += details.data.additions ?? 0;
        deletions += details.data.deletions ?? 0;
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Failed to load PR details for ${pullRequest.repoFullName}#${pullRequest.number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const mostActiveRepo = computeMostActiveRepo(roomotePullRequests);
  const topUsers = computeTopUsers(roomotePullRequests, metadataByKey);

  return {
    activeUsers: await getActiveUserCount(params.since),
    roomotePullRequests: roomotePullRequests.length,
    authoredPullRequests: authored.length,
    reviewedPullRequests: reviewed.length,
    totalPullRequests: pullRequests.length,
    roomotePullRequestPercentage:
      pullRequests.length === 0
        ? 0
        : (roomotePullRequests.length / pullRequests.length) * 100,
    mergedRoomotePullRequests: mergedRoomotePullRequests.length,
    // Denominator is authored PRs since merged stats are authored-only.
    mergedRoomotePullRequestPercentage:
      authored.length === 0
        ? 0
        : (mergedRoomotePullRequests.length / authored.length) * 100,
    additions,
    deletions,
    locScope,
    mostActiveRepo,
    topUsers,
  } satisfies ManagerStatsDigest;
}
