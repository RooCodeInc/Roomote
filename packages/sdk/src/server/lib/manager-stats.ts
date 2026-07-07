import * as GitHub from '@roomote/github';

import {
  db,
  repositories,
  taskPullRequests,
  tasks,
  users,
  eq,
  gte,
  resolveTaskAttributionDisplay,
} from '@roomote/db/server';

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
      taskAttributionKind: tasks.attributionKind,
      taskAttributedUserId: tasks.attributedUserId,
      taskAttributionSourceKind: tasks.attributionSourceKind,
      taskAttributionSourceDisplayName: tasks.attributionSourceDisplayName,
      taskAttributionSourceExternalId: tasks.attributionSourceExternalId,
      taskAttributedGithubLogin: tasks.attributedGithubLogin,
      taskEffectiveAuthorKind: tasks.effectiveAuthorKind,
      taskEffectiveAuthorUserId: tasks.effectiveAuthorUserId,
      taskEffectiveAuthorDisplayName: tasks.effectiveAuthorDisplayName,
      taskEffectiveAuthorGithubLogin: tasks.effectiveAuthorGithubLogin,
      taskUserName: users.name,
      taskUserEmail: users.email,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .leftJoin(users, eq(users.id, tasks.attributedUserId));

  const metadataByKey = new Map<string, PullRequestMetadata>();

  for (const row of results) {
    if (!row.repository || row.prNumber === null) {
      continue;
    }
    const attribution = resolveTaskAttributionDisplay(
      {
        attributionKind: row.taskAttributionKind,
        attributedUserId: row.taskAttributedUserId,
        attributionSourceKind: row.taskAttributionSourceKind,
        attributionSourceDisplayName: row.taskAttributionSourceDisplayName,
        attributionSourceExternalId: row.taskAttributionSourceExternalId,
        attributedGithubLogin: row.taskAttributedGithubLogin,
        effectiveAuthorKind: row.taskEffectiveAuthorKind,
        effectiveAuthorUserId: row.taskEffectiveAuthorUserId,
        effectiveAuthorDisplayName: row.taskEffectiveAuthorDisplayName,
        effectiveAuthorGithubLogin: row.taskEffectiveAuthorGithubLogin,
      },
      {
        attributedUser: {
          id: row.taskAttributedUserId,
          name: row.taskUserName,
          email: row.taskUserEmail,
        },
      },
    );

    metadataByKey.set(getPullRequestKey(row.repository, row.prNumber), {
      canonicalTaskId: row.taskId,
      userLabel: attribution.analyticsDisplay,
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
      attributionKind: tasks.attributionKind,
      attributedUserId: tasks.attributedUserId,
      attributionSourceKind: tasks.attributionSourceKind,
      attributionSourceDisplayName: tasks.attributionSourceDisplayName,
      attributionSourceExternalId: tasks.attributionSourceExternalId,
      attributedGithubLogin: tasks.attributedGithubLogin,
      effectiveAuthorKind: tasks.effectiveAuthorKind,
      effectiveAuthorUserId: tasks.effectiveAuthorUserId,
      effectiveAuthorDisplayName: tasks.effectiveAuthorDisplayName,
      effectiveAuthorGithubLogin: tasks.effectiveAuthorGithubLogin,
      userName: users.name,
      userEmail: users.email,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.attributedUserId))
    .where(gte(tasks.createdAt, since));

  const humanCreatorKeys = rows.flatMap((row) => {
    const attribution = resolveTaskAttributionDisplay(
      {
        attributionKind: row.attributionKind,
        attributedUserId: row.attributedUserId,
        attributionSourceKind: row.attributionSourceKind,
        attributionSourceDisplayName: row.attributionSourceDisplayName,
        attributionSourceExternalId: row.attributionSourceExternalId,
        attributedGithubLogin: row.attributedGithubLogin,
        effectiveAuthorKind: row.effectiveAuthorKind,
        effectiveAuthorUserId: row.effectiveAuthorUserId,
        effectiveAuthorDisplayName: row.effectiveAuthorDisplayName,
        effectiveAuthorGithubLogin: row.effectiveAuthorGithubLogin,
      },
      {
        attributedUser: {
          id: row.attributedUserId,
          name: row.userName,
          email: row.userEmail,
        },
      },
    );

    if (attribution.kind === 'automatic') {
      return [];
    }

    if (attribution.kind === 'matched_user') {
      const matchedUserId =
        row.effectiveAuthorKind === 'human' && row.effectiveAuthorUserId
          ? row.effectiveAuthorUserId
          : row.attributedUserId;

      return matchedUserId ? [`matched:${matchedUserId}`] : [];
    }

    if (row.attributionSourceKind && row.attributionSourceExternalId) {
      return [
        `unlinked:${row.attributionSourceKind}:${row.attributionSourceExternalId}`,
      ];
    }

    return [
      `unlinked:${attribution.sourceKind}:${attribution.analyticsDisplay}`,
    ];
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
