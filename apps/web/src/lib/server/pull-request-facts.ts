import type { PullRequestAnalyticsItem } from '@roomote/github';
import {
  and,
  db,
  desc,
  gte,
  pullRequestFacts,
  pullRequestSyncStates,
  inArray,
} from '@roomote/db/server';

import type { TimePeriodFilter } from '@/types';

function getTimeCutoff(
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Date | null {
  if (!timePeriod || timePeriod === 'all') {
    return null;
  }

  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (timePeriod - 1));
  return cutoff;
}

export async function getStoredPullRequestsForAnalytics(params: {
  repositoryIds: string[];
  timePeriod: TimePeriodFilter | undefined;
  now: Date;
}): Promise<PullRequestAnalyticsItem[]> {
  if (params.repositoryIds.length === 0) {
    return [];
  }

  const createdAfter = getTimeCutoff(params.timePeriod, params.now);

  const rows = await db
    .select({
      authorLogin: pullRequestFacts.authorLogin,
      closedAt: pullRequestFacts.closedAtRemote,
      createdAt: pullRequestFacts.createdAtRemote,
      externalPullRequestId: pullRequestFacts.externalPullRequestId,
      htmlUrl: pullRequestFacts.htmlUrl,
      mergedAt: pullRequestFacts.mergedAtRemote,
      prNumber: pullRequestFacts.prNumber,
      repositoryFullName: pullRequestFacts.repositoryFullName,
      state: pullRequestFacts.state,
      title: pullRequestFacts.title,
      updatedAt: pullRequestFacts.updatedAtRemote,
    })
    .from(pullRequestFacts)
    .where(
      and(
        inArray(pullRequestFacts.repositoryId, params.repositoryIds),
        createdAfter
          ? gte(pullRequestFacts.createdAtRemote, createdAfter)
          : undefined,
      ),
    )
    .orderBy(desc(pullRequestFacts.createdAtRemote));

  return rows.map((row) => ({
    authorLogin: row.authorLogin,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    externalPullRequestId: row.externalPullRequestId,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    number: row.prNumber,
    repoFullName: row.repositoryFullName,
    state: row.state,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    url: row.htmlUrl,
  }));
}

export async function getPullRequestFactRepositoryIdsNeedingBackfill(params: {
  repositoryIds: string[];
}): Promise<string[]> {
  if (params.repositoryIds.length === 0) {
    return [];
  }

  const syncStates = await db
    .select({
      repositoryId: pullRequestSyncStates.repositoryId,
      backfillCompletedAt: pullRequestSyncStates.backfillCompletedAt,
    })
    .from(pullRequestSyncStates)
    .where(inArray(pullRequestSyncStates.repositoryId, params.repositoryIds));

  const syncStateByRepositoryId = new Map(
    syncStates.map((syncState) => [syncState.repositoryId, syncState]),
  );

  return params.repositoryIds.filter((repositoryId) => {
    const syncState = syncStateByRepositoryId.get(repositoryId);
    return !syncState?.backfillCompletedAt;
  });
}
