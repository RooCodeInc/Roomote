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

type PullRequestMetadata = {
  canonicalTaskId: string;
  userLabel: string;
};

export type ManagerStatsDigest = {
  activeUsers: number;
  roomotePullRequests: number;
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

function isRoomotePullRequestAuthor(login: string | null) {
  if (!login) {
    return false;
  }

  const normalizedLogin = login.trim().toLowerCase();

  return (
    GitHub.Schemas.isRoomoteGitHubLogin(normalizedLogin) ||
    normalizedLogin === 'newmote[bot]' ||
    normalizedLogin === 'app/newmote'
  );
}

async function getRoomotePullRequestMetadataByKey() {
  const results = await db
    .select({
      taskId: taskPullRequests.taskId,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
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

  const metadataByKey = new Map<string, PullRequestMetadata>();

  for (const row of results) {
    if (!row.repository || row.prNumber === null) {
      continue;
    }

    metadataByKey.set(getPullRequestKey(row.repository, row.prNumber), {
      canonicalTaskId: row.taskId,
      userLabel: getInitiatorLabel(row),
    });
  }

  return metadataByKey;
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

export async function buildManagerStatsDigest(params: {
  actorUserId: string;
  since: Date;
}) {
  const repositoryIds = await getAnalyticsRepositoryIds();

  if (repositoryIds.length === 0) {
    return {
      activeUsers: await getActiveUserCount(params.since),
      roomotePullRequests: 0,
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

  const roomotePullRequests = pullRequests.filter((pullRequest) => {
    return (
      metadataByKey.has(
        getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
      ) || isRoomotePullRequestAuthor(pullRequest.authorLogin)
    );
  });
  const mergedRoomotePullRequests = roomotePullRequests.filter(
    (pullRequest) => pullRequest.state === 'merged',
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
    totalPullRequests: pullRequests.length,
    roomotePullRequestPercentage:
      pullRequests.length === 0
        ? 0
        : (roomotePullRequests.length / pullRequests.length) * 100,
    mergedRoomotePullRequests: mergedRoomotePullRequests.length,
    mergedRoomotePullRequestPercentage:
      roomotePullRequests.length === 0
        ? 0
        : (mergedRoomotePullRequests.length / roomotePullRequests.length) * 100,
    additions,
    deletions,
    mostActiveRepo,
    topUsers,
  } satisfies ManagerStatsDigest;
}
