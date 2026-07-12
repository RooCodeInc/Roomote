import * as GitHub from '@roomote/github';
import { formatAutomationLabel } from '@roomote/types';

import {
  db,
  repositories,
  taskPullRequests,
  tasks,
  users,
  eq,
  gte,
} from '@roomote/db/server';

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
    // named consistently (e.g. `pr_review` -> "PR Review") across surfaces.
    return row.initiatorAutomation
      ? formatAutomationLabel(row.initiatorAutomation)
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

type PullRequestMetadata = {
  canonicalTaskId: string;
  userLabel: string;
  classification: PullRequestClassification;
};

type PullRequestMetadataRow = TaskInitiatorRow & {
  taskId: string;
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
  mostActiveRepo: {
    fullName: string;
    pullRequestCount: number;
  } | null;
  topUsers: Array<{
    label: string;
    pullRequestCount: number;
  }>;
};

function getPullRequestKey(repoFullName: string, prNumber: number) {
  return `${repoFullName.toLowerCase()}#${prNumber}`;
}

/**
 * A `pr_review` task reviewed someone else's PR; any other workflow means the
 * task produced (authored) the PR.
 */
function classifyWorkflow(workflow: string | null): PullRequestClassification {
  return workflow === 'pr_review' ? 'reviewed' : 'authored';
}

function isRoomotePullRequestAuthor(login: string | null) {
  if (!login) {
    return false;
  }

  const normalizedLogin = login.trim().toLowerCase();

  return GitHub.Schemas.isRoomoteGitHubLogin(normalizedLogin);
}

/**
 * Fold task/PR rows into per-PR metadata, keyed by repo#number.
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

    const key = getPullRequestKey(row.repository, row.prNumber);
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
      classification,
    });
  }

  return metadataByKey;
}

async function getRoomotePullRequestMetadataByKey() {
  const results = await db
    .select({
      taskId: taskPullRequests.taskId,
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

async function getAnalyticsRepositoryIds() {
  const rows = await db.query.repositories.findMany({
    where: eq(repositories.isActive, true),
    columns: {
      id: true,
    },
  });

  return rows.map((row) => row.id);
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

type RoomotePullRequestInput = {
  repoFullName: string;
  number: number;
  state: string;
  authorLogin: string | null;
};

type ClassifiedPullRequest<T extends RoomotePullRequestInput> = {
  pullRequest: T;
  classification: PullRequestClassification;
};

/**
 * Filter the analytics PRs down to Roomote-linked ones and classify each as
 * authored or reviewed.
 *
 * A PR reaches here if it has task metadata OR was opened by the Roomote bot.
 * `authored` wins whenever any authored signal is present: an authoring task
 * row (`metadata.classification === 'authored'`) or a bot-authored PR, even if
 * a `pr_review` task also touched it. A PR is only `reviewed` when its metadata
 * is a review row and Roomote is not the PR author.
 */
export function summarizeRoomotePullRequests<
  T extends RoomotePullRequestInput,
>({
  pullRequests,
  metadataByKey,
}: {
  pullRequests: T[];
  metadataByKey: Map<string, PullRequestMetadata>;
}) {
  const roomotePullRequests: Array<ClassifiedPullRequest<T>> = [];

  for (const pullRequest of pullRequests) {
    const metadata = metadataByKey.get(
      getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
    );
    const isAuthorMatch = isRoomotePullRequestAuthor(pullRequest.authorLogin);

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

export async function buildManagerStatsDigest(params: {
  actorUserId: string;
  since: Date;
}) {
  // isRoomotePullRequestAuthor classifies logins synchronously from the
  // cached configured app slug.
  await GitHub.resolveConfiguredGitHubAppSlug();

  const repositoryIds = await getAnalyticsRepositoryIds();

  if (repositoryIds.length === 0) {
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
      mostActiveRepo: null,
      topUsers: [],
    } satisfies ManagerStatsDigest;
  }

  const [pullRequests, metadataByKey] = await Promise.all([
    GitHub.getPullRequestsForAnalytics({
      userId: params.actorUserId,
      repositoryIds,
      createdAfter: params.since,
    }),
    getRoomotePullRequestMetadataByKey(),
  ]);

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

  for (const pullRequest of roomotePullRequests) {
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
        `[managerStats] Failed to load PR details for ${pullRequest.repoFullName}#${pullRequest.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const repoCounts = new Map<string, number>();
  const userCounts = new Map<string, number>();

  for (const pullRequest of roomotePullRequests) {
    repoCounts.set(
      pullRequest.repoFullName,
      (repoCounts.get(pullRequest.repoFullName) ?? 0) + 1,
    );

    const metadata = metadataByKey.get(
      getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
    );
    const label =
      metadata?.userLabel ?? pullRequest.authorLogin ?? 'Unknown user';

    userCounts.set(label, (userCounts.get(label) ?? 0) + 1);
  }

  const mostActiveRepo =
    [...repoCounts.entries()]
      .map(([fullName, pullRequestCount]) => ({
        fullName,
        pullRequestCount,
      }))
      .sort((left, right) => {
        if (right.pullRequestCount !== left.pullRequestCount) {
          return right.pullRequestCount - left.pullRequestCount;
        }

        return left.fullName.localeCompare(right.fullName);
      })[0] ?? null;

  const topUsers = [...userCounts.entries()]
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
    .slice(0, 3);

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
    mostActiveRepo,
    topUsers,
  } satisfies ManagerStatsDigest;
}
