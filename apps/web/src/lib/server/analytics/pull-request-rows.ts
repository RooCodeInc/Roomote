import * as GitHub from '@roomote/github';
import { syncGitHubPullRequestFactsForOrg } from '@roomote/sdk/server';

import { type PullRequestStatus, PRODUCT_NAME } from '@roomote/types';
import {
  db,
  tasks,
  users,
  taskPullRequests,
  githubUserMappings,
  eq,
  inArray,
} from '@roomote/db/server';

import {
  type AnalyticsGranularity,
  type TimePeriodFilter,
  type PullRequestAnalyticsSummary,
} from '@/types';
import type { UserAuthSuccess } from '@/types';

import { getRepositories } from '../source-control';
import {
  getPullRequestFactRepositoryIdsNeedingBackfill,
  getStoredPullRequestsForAnalytics,
} from '../pull-request-facts';
import {
  HUMAN_CREATED_BY_LABEL,
  NO_VALUE_LABEL,
  ROOMOTE_CREATED_BY_LABEL,
  UNKNOWN_REPO_LABEL,
  taskInitiatorUsers,
  type AnalyticsDimensionValue,
  type PullRequestAnalyticsRow,
} from './types';
import {
  createDimensionValue,
  createLabelBackedDimensionValue,
  formatRepositoryLabel,
  getPullRequestKey,
  getTaskInitiatorDimensionValue,
  resolveDimensionLabelCollisions,
} from './dimensions';
import {
  formatAnalyticsDateTime,
  getRequestTimeBootstrapCutoff,
  getSummaryPeriodCount,
} from './time-buckets';

function formatPullRequestStatus(status: PullRequestStatus) {
  switch (status) {
    case 'open':
      return 'Open';
    case 'draft':
      return 'Draft';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return status;
  }
}

function formatPullRequestLabel(title: string, prNumber: number) {
  return title.trim() ? title : `#${prNumber}`;
}

function formatGitHubAuthorLabel(
  login: string | null,
  mappedName: string | null | undefined,
) {
  if (!login) {
    return NO_VALUE_LABEL;
  }

  const githubHandle = `@${login}`;

  return mappedName ? `${mappedName} (${githubHandle})` : githubHandle;
}

function getCanonicalGitHubAuthorDimensionValue(params: {
  login: string | null;
  mappedUserId: string | null | undefined;
  mappedName: string | null | undefined;
  isRoomote: boolean;
}) {
  if (params.isRoomote) {
    return createDimensionValue(PRODUCT_NAME, PRODUCT_NAME);
  }

  const normalizedLogin = params.login?.trim().toLowerCase() ?? null;
  const mappedName = params.mappedName?.trim() ?? null;

  if (params.mappedUserId) {
    const label =
      mappedName || (normalizedLogin ? `@${normalizedLogin}` : NO_VALUE_LABEL);

    return createDimensionValue(
      `user:${params.mappedUserId}`,
      label,
      formatGitHubAuthorLabel(normalizedLogin, mappedName),
    );
  }

  if (!normalizedLogin) {
    return createDimensionValue(NO_VALUE_LABEL, NO_VALUE_LABEL);
  }

  return createDimensionValue(
    `github:${normalizedLogin}`,
    `@${normalizedLogin}`,
  );
}

function isAnalyticsRoomoteGitHubLogin(login: string | null) {
  if (!login) {
    return false;
  }

  const normalizedLogin = login.trim().toLowerCase();

  return GitHub.Schemas.isRoomoteGitHubLogin(normalizedLogin);
}

function isRoomotePullRequestAuthor(login: string | null) {
  return isAnalyticsRoomoteGitHubLogin(login);
}

async function getRoomotePullRequestMetadataByKey(_auth: UserAuthSuccess) {
  // isRoomotePullRequestAuthor classifies logins synchronously from the
  // cached configured app slug.
  await GitHub.resolveConfiguredGitHubAppSlug();

  const results = await db
    .select({
      taskId: taskPullRequests.taskId,
      repository: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      detectedAt: taskPullRequests.detectedAt,
      updatedAt: taskPullRequests.updatedAt,
      taskInitiatorKind: tasks.initiatorKind,
      taskInitiatorUserId: tasks.initiatorUserId,
      taskInitiatorAutomation: tasks.initiatorAutomation,
      taskActorExternalId: tasks.actorExternalId,
      taskActorDisplayName: tasks.actorDisplayName,
      taskUserName: taskInitiatorUsers.name,
      taskUserEmail: taskInitiatorUsers.email,
      sourceControlProvider: taskPullRequests.sourceControlProvider,
      host: taskPullRequests.host,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .leftJoin(
      taskInitiatorUsers,
      eq(taskInitiatorUsers.id, tasks.initiatorUserId),
    );

  const deduped = new Map<
    string,
    {
      canonicalTaskId: string;
      detectedAt: Date;
      updatedAt: Date;
      userDimension: AnalyticsDimensionValue;
    }
  >();

  for (const result of results) {
    if (!result.repository || result.prNumber === null) {
      continue;
    }

    const dedupeKey = getPullRequestKey(
      result.repository,
      result.prNumber,
      result.sourceControlProvider,
      result.host ?? undefined,
    );
    const existing = deduped.get(dedupeKey);

    if (
      !existing ||
      result.detectedAt < existing.detectedAt ||
      (result.detectedAt.getTime() === existing.detectedAt.getTime() &&
        result.updatedAt < existing.updatedAt)
    ) {
      deduped.set(dedupeKey, {
        canonicalTaskId: result.taskId,
        detectedAt: result.detectedAt,
        updatedAt: result.updatedAt,
        userDimension: getTaskInitiatorDimensionValue({
          initiatorKind: result.taskInitiatorKind,
          initiatorUserId: result.taskInitiatorUserId,
          initiatorAutomation: result.taskInitiatorAutomation,
          actorExternalId: result.taskActorExternalId,
          actorDisplayName: result.taskActorDisplayName,
          userName: result.taskUserName,
          userEmail: result.taskUserEmail,
        }),
      });
    }
  }

  return deduped;
}

async function getGitHubUserByLogin(logins: string[]) {
  if (logins.length === 0) {
    return new Map<
      string,
      { userId: string | null; userName: string | null }
    >();
  }

  const mappings = await db
    .select({
      githubLogin: githubUserMappings.githubLogin,
      userId: users.id,
      userName: users.name,
      updatedAt: githubUserMappings.updatedAt,
    })
    .from(githubUserMappings)
    .leftJoin(users, eq(users.id, githubUserMappings.userId))
    .where(inArray(githubUserMappings.githubLogin, logins));

  const latestByLogin = new Map<
    string,
    { userId: string | null; userName: string | null; updatedAt: Date }
  >();

  for (const mapping of mappings) {
    const existing = latestByLogin.get(mapping.githubLogin);

    if (!existing || mapping.updatedAt > existing.updatedAt) {
      latestByLogin.set(mapping.githubLogin, {
        userId: mapping.userId,
        userName: mapping.userName,
        updatedAt: mapping.updatedAt,
      });
    }
  }

  return new Map(
    [...latestByLogin.entries()].map(([login, value]) => [
      login,
      {
        userId: value.userId,
        userName: value.userName,
      },
    ]),
  );
}

export function buildPullRequestAnalyticsSummary(
  rows: PullRequestAnalyticsRow[],
  timePeriod: TimePeriodFilter | undefined,
  granularity: AnalyticsGranularity,
  now: Date,
): PullRequestAnalyticsSummary {
  const totalPullRequests = rows.length;
  const roomotePullRequests = rows.filter((row) => row.meta.isRoomote);
  const mergedRoomotePullRequests = roomotePullRequests.filter(
    (row) => row.meta.isMerged,
  );
  const uniqueAuthors = new Set(
    rows
      .map((row) => row.dimensions.author?.key)
      .filter((authorKey): authorKey is string => Boolean(authorKey)),
  );
  const pullRequestsPerAuthor =
    uniqueAuthors.size === 0 ? null : totalPullRequests / uniqueAuthors.size;
  const periodCount = getSummaryPeriodCount(rows, timePeriod, granularity, now);

  return {
    totalPullRequests,
    roomotePullRequests: {
      total: roomotePullRequests.length,
      percentage:
        totalPullRequests === 0
          ? 0
          : (roomotePullRequests.length / totalPullRequests) * 100,
    },
    mergedRoomotePullRequests: {
      total: mergedRoomotePullRequests.length,
      percentage:
        roomotePullRequests.length === 0
          ? 0
          : (mergedRoomotePullRequests.length / roomotePullRequests.length) *
            100,
    },
    authorCount: uniqueAuthors.size,
    pullRequestsPerAuthor,
    pullRequestsPerAuthorPerPeriod:
      pullRequestsPerAuthor === null || periodCount === 0
        ? null
        : pullRequestsPerAuthor / periodCount,
  };
}

export async function getPullRequestAnalyticsRows(
  auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<PullRequestAnalyticsRow[]> {
  const repositories = await getRepositories(auth);

  if (repositories.length === 0) {
    return [];
  }

  const repositoryIds = repositories.map((repository) => repository.id);
  const repositoryIdsNeedingBackfill =
    await getPullRequestFactRepositoryIdsNeedingBackfill({
      repositoryIds,
    });
  const requestTimeBootstrapCutoff = getRequestTimeBootstrapCutoff(
    timePeriod,
    now,
  );

  if (requestTimeBootstrapCutoff && repositoryIdsNeedingBackfill.length > 0) {
    try {
      await syncGitHubPullRequestFactsForOrg({
        actorUserId: auth.userId,
        bootstrapCreatedAfter: requestTimeBootstrapCutoff,
        repositoryIds: repositoryIdsNeedingBackfill,
        now,
      });
    } catch (error) {
      console.warn(
        `[analytics] Failed to bootstrap PR fact cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const [livePullRequests, roomoteMetadataByKey] = await Promise.all([
    getStoredPullRequestsForAnalytics({
      repositoryIds,
      timePeriod,
      now,
    }),
    getRoomotePullRequestMetadataByKey(auth),
  ]);

  const githubUserByLogin = await getGitHubUserByLogin(
    [...new Set(livePullRequests.map((pullRequest) => pullRequest.authorLogin))]
      .filter((login): login is string => Boolean(login))
      .sort((left, right) => left.localeCompare(right)),
  );

  return resolveDimensionLabelCollisions(
    livePullRequests.map((pullRequest) => {
      const roomoteMetadata = roomoteMetadataByKey.get(
        getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
      );
      const isRoomote =
        Boolean(roomoteMetadata) ||
        isRoomotePullRequestAuthor(pullRequest.authorLogin);
      const timestamp = new Date(pullRequest.createdAt);
      const mappedAuthor = pullRequest.authorLogin
        ? githubUserByLogin.get(pullRequest.authorLogin)
        : null;
      const mappedAuthorName = mappedAuthor?.userName ?? null;
      const authorLabel = formatGitHubAuthorLabel(
        pullRequest.authorLogin,
        mappedAuthorName,
      );
      const canonicalAuthorDimension = getCanonicalGitHubAuthorDimensionValue({
        login: pullRequest.authorLogin,
        mappedUserId: mappedAuthor?.userId,
        mappedName: mappedAuthorName,
        isRoomote,
      });
      const userLabel = roomoteMetadata?.userDimension.label ?? authorLabel;
      const canonicalUserDimension =
        roomoteMetadata?.userDimension ?? canonicalAuthorDimension;
      const statusLabel = formatPullRequestStatus(pullRequest.state);
      const repoLabel = pullRequest.repoFullName
        ? formatRepositoryLabel(pullRequest.repoFullName)
        : UNKNOWN_REPO_LABEL;
      const prLabel = formatPullRequestLabel(
        pullRequest.title,
        pullRequest.number,
      );
      const taskLink = roomoteMetadata
        ? `/task/${roomoteMetadata.canonicalTaskId}`
        : undefined;

      return {
        id: getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
        timestamp,
        value: 1,
        dimensions: {
          user: canonicalUserDimension,
          author: canonicalAuthorDimension,
          status: createLabelBackedDimensionValue(statusLabel),
          repo: createLabelBackedDimensionValue(repoLabel),
        },
        details: {
          id: getPullRequestKey(pullRequest.repoFullName, pullRequest.number),
          values: {
            date: formatAnalyticsDateTime(timestamp),
            user: userLabel,
            author: authorLabel,
            repo: repoLabel,
            pr: prLabel,
            status: statusLabel,
            createdBy: isRoomote
              ? ROOMOTE_CREATED_BY_LABEL
              : HUMAN_CREATED_BY_LABEL,
            task: roomoteMetadata ? 'View task' : NO_VALUE_LABEL,
          },
          links: {
            pr: pullRequest.url,
            ...(taskLink ? { task: taskLink } : {}),
          },
        },
        meta: {
          authorLogin: pullRequest.authorLogin,
          canonicalTaskId: roomoteMetadata?.canonicalTaskId ?? null,
          isMerged: pullRequest.state === 'merged',
          isRoomote,
        },
      } satisfies PullRequestAnalyticsRow;
    }),
  );
}
