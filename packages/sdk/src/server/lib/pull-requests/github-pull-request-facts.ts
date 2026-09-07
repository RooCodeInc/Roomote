import * as GitHub from '@roomote/github';
import {
  and,
  db,
  eq,
  githubInstallations,
  pullRequestSyncStates,
  inArray,
  isNull,
  repositories,
} from '@roomote/db/server';

import {
  getLatestUpdatedAt,
  upsertPullRequestFacts,
  upsertPullRequestSyncState,
  type PullRequestFactSnapshot,
} from './pull-request-facts-store';

const MAX_REPOSITORIES_PER_RUN = 8;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

function toPullRequestFactSnapshot(
  pullRequest: GitHub.PullRequestAnalyticsItem,
): PullRequestFactSnapshot {
  return {
    ...pullRequest,
    body: pullRequest.body ?? null,
    labels: pullRequest.labels ?? null,
  };
}

function getRateLimitCooldownUntil(error: unknown, now: Date): Date | null {
  if (!(error instanceof Error) || !('status' in error)) {
    return null;
  }

  const status =
    typeof error.status === 'number' ? error.status : Number(error.status);

  if (status !== 403 && status !== 429) {
    return null;
  }

  const headers =
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'headers' in error.response &&
    error.response.headers &&
    typeof error.response.headers === 'object'
      ? error.response.headers
      : null;

  const retryAfterHeader =
    headers && 'retry-after' in headers ? headers['retry-after'] : null;

  if (typeof retryAfterHeader === 'string') {
    const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return new Date(now.getTime() + retryAfterSeconds * 1000);
    }
  }

  const rateLimitResetHeader =
    headers && 'x-ratelimit-reset' in headers
      ? headers['x-ratelimit-reset']
      : null;

  if (typeof rateLimitResetHeader === 'string') {
    const resetSeconds = Number.parseInt(rateLimitResetHeader, 10);

    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      return new Date(resetSeconds * 1000);
    }
  }

  return new Date(now.getTime() + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
}

async function syncRepositoryPullRequestFacts(params: {
  actorUserId: string;
  repositoryId: string;
  repositoryFullName: string;
  backfillCompletedAt: Date | null;
  bootstrapCreatedAfter?: Date | null;
  lastIncrementalUpdatedAt: Date | null;
  now: Date;
}) {
  const attemptedAt = params.now;

  try {
    let backfillPullRequests: PullRequestFactSnapshot[] = [];
    const isRequestTimeBootstrap =
      !params.backfillCompletedAt && Boolean(params.bootstrapCreatedAfter);

    if (!params.backfillCompletedAt) {
      backfillPullRequests = (
        await GitHub.getPullRequestsForAnalytics({
          userId: params.actorUserId,
          repositoryIds: [params.repositoryId],
          createdAfter: params.bootstrapCreatedAfter,
        })
      ).map(toPullRequestFactSnapshot);

      await upsertPullRequestFacts({
        repositoryId: params.repositoryId,
        repositoryFullName: params.repositoryFullName,
        sourceControlProvider: 'github',
        pullRequests: backfillPullRequests,
        syncedAt: params.now,
      });
    }

    if (isRequestTimeBootstrap) {
      await upsertPullRequestSyncState({
        repositoryId: params.repositoryId,
        lastIncrementalUpdatedAt:
          getLatestUpdatedAt(
            backfillPullRequests,
            params.lastIncrementalUpdatedAt ?? params.bootstrapCreatedAfter!,
          ) ?? params.bootstrapCreatedAfter!,
        backfillCompletedAt: null,
        cooldownUntil: null,
        lastSuccessfulSyncAt: params.now,
        lastAttemptedSyncAt: attemptedAt,
        lastErrorAt: null,
        lastErrorMessage: null,
      });

      return { success: true as const };
    }

    const previousUpdatedAt =
      params.lastIncrementalUpdatedAt ??
      (backfillPullRequests.length > 0
        ? (getLatestUpdatedAt(backfillPullRequests, null) ?? params.now)
        : params.now);

    const incrementalPullRequests = (
      await GitHub.getUpdatedPullRequestsForAnalytics({
        userId: params.actorUserId,
        repositoryIds: [params.repositoryId],
        updatedAfter: previousUpdatedAt,
      })
    ).map(toPullRequestFactSnapshot);

    await upsertPullRequestFacts({
      repositoryId: params.repositoryId,
      repositoryFullName: params.repositoryFullName,
      sourceControlProvider: 'github',
      pullRequests: incrementalPullRequests,
      syncedAt: params.now,
    });

    const latestUpdatedAt =
      incrementalPullRequests.length > 0
        ? (getLatestUpdatedAt(incrementalPullRequests, previousUpdatedAt) ??
          previousUpdatedAt)
        : previousUpdatedAt;

    await upsertPullRequestSyncState({
      repositoryId: params.repositoryId,
      lastIncrementalUpdatedAt: latestUpdatedAt,
      backfillCompletedAt: params.backfillCompletedAt ?? params.now,
      cooldownUntil: null,
      lastSuccessfulSyncAt: params.now,
      lastAttemptedSyncAt: attemptedAt,
      lastErrorAt: null,
      lastErrorMessage: null,
    });

    return { success: true as const };
  } catch (error) {
    const cooldownUntil = getRateLimitCooldownUntil(error, params.now);

    await upsertPullRequestSyncState({
      repositoryId: params.repositoryId,
      lastIncrementalUpdatedAt: params.lastIncrementalUpdatedAt,
      backfillCompletedAt: params.backfillCompletedAt,
      cooldownUntil,
      lastSuccessfulSyncAt: null,
      lastAttemptedSyncAt: attemptedAt,
      lastErrorAt: params.now,
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false as const,
      cooldownUntil,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncGitHubPullRequestFactsForOrg(params: {
  actorUserId: string;
  now?: Date;
  bootstrapCreatedAfter?: Date | null;
  repositoryIds?: string[];
}) {
  const now = params.now ?? new Date();

  const [repositoryRows, syncStateRows] = await Promise.all([
    // Scoped to GitHub rows: non-GitHub repositories are synced by the
    // provider-neutral merged-PR facts sync, which owns their
    // pull_request_sync_states rows.
    db.query.repositories.findMany({
      where: and(
        eq(repositories.isActive, true),
        eq(repositories.sourceControlProvider, 'github'),
      ),
    }),
    db.query.pullRequestSyncStates.findMany(),
  ]);

  const syncStateByRepositoryId = new Map(
    syncStateRows.map((syncState) => [syncState.repositoryId, syncState]),
  );
  const targetRepositoryIds = params.repositoryIds
    ? new Set(params.repositoryIds)
    : null;

  const eligibleRepositories = repositoryRows
    .filter((repository) =>
      targetRepositoryIds ? targetRepositoryIds.has(repository.id) : true,
    )
    .filter((repository) => {
      const syncState = syncStateByRepositoryId.get(repository.id);
      return !syncState?.cooldownUntil || syncState.cooldownUntil <= now;
    })
    .sort((left, right) => {
      const leftSyncAt =
        syncStateByRepositoryId.get(left.id)?.lastSuccessfulSyncAt?.getTime() ??
        0;
      const rightSyncAt =
        syncStateByRepositoryId
          .get(right.id)
          ?.lastSuccessfulSyncAt?.getTime() ?? 0;

      if (leftSyncAt !== rightSyncAt) {
        return leftSyncAt - rightSyncAt;
      }

      return left.fullName.localeCompare(right.fullName);
    });
  const repositoriesToProcess = targetRepositoryIds
    ? params.bootstrapCreatedAfter
      ? eligibleRepositories
      : eligibleRepositories.slice(0, MAX_REPOSITORIES_PER_RUN)
    : eligibleRepositories.slice(0, MAX_REPOSITORIES_PER_RUN);

  let processedRepositories = 0;
  let failedRepositories = 0;
  let cooledDownRepositories = 0;

  for (const repository of repositoriesToProcess) {
    const syncState = syncStateByRepositoryId.get(repository.id);
    const result = await syncRepositoryPullRequestFacts({
      actorUserId: params.actorUserId,
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      backfillCompletedAt: syncState?.backfillCompletedAt ?? null,
      bootstrapCreatedAfter: params.bootstrapCreatedAfter,
      lastIncrementalUpdatedAt: syncState?.lastIncrementalUpdatedAt ?? null,
      now,
    });

    if (result.success) {
      processedRepositories += 1;
      continue;
    }

    failedRepositories += 1;

    if (result.cooldownUntil) {
      cooledDownRepositories += 1;
    }
  }

  return {
    eligibleRepositories: repositoriesToProcess.length,
    processedRepositories,
    failedRepositories,
    cooledDownRepositories,
  };
}

export async function syncGitHubPullRequestFactsForAllOrgs(params?: {
  now?: Date;
}) {
  const now = params?.now ?? new Date();
  const installation = await db
    .select({
      actorUserId: githubInstallations.installedByUserId,
    })
    .from(githubInstallations)
    .where(isNull(githubInstallations.suspendedAt))
    .limit(1);

  if (!installation[0]) {
    return [];
  }

  return [
    await syncGitHubPullRequestFactsForOrg({
      actorUserId: installation[0].actorUserId,
      now,
    }),
  ];
}

export async function upsertGitHubPullRequestFactFromWebhook(params: {
  githubRepoId: number;
  repositoryFullName: string;
  pullRequest: PullRequestFactSnapshot;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  const matchingRepositories = await db
    .select({
      repositoryId: repositories.id,
      repositoryFullName: repositories.fullName,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.fullName, params.repositoryFullName),
        eq(repositories.githubRepoId, params.githubRepoId),
        eq(repositories.isActive, true),
      ),
    );

  if (matchingRepositories.length === 0) {
    return;
  }
  const existingSyncStates = await db
    .select()
    .from(pullRequestSyncStates)
    .where(
      inArray(
        pullRequestSyncStates.repositoryId,
        matchingRepositories.map((repository) => repository.repositoryId),
      ),
    );
  const existingSyncStateByRepositoryId = new Map(
    existingSyncStates.map((syncState) => [syncState.repositoryId, syncState]),
  );

  await Promise.all(
    matchingRepositories.map(async (repository) => {
      const existingSyncState = existingSyncStateByRepositoryId.get(
        repository.repositoryId,
      );
      const updatedAt = new Date(params.pullRequest.updatedAt);
      const lastIncrementalUpdatedAt =
        existingSyncState?.lastIncrementalUpdatedAt &&
        existingSyncState.lastIncrementalUpdatedAt > updatedAt
          ? existingSyncState.lastIncrementalUpdatedAt
          : updatedAt;

      await upsertPullRequestFacts({
        repositoryId: repository.repositoryId,
        repositoryFullName: repository.repositoryFullName,
        sourceControlProvider: 'github',
        pullRequests: [params.pullRequest],
        syncedAt: now,
      });

      await upsertPullRequestSyncState({
        repositoryId: repository.repositoryId,
        lastIncrementalUpdatedAt,
        backfillCompletedAt: existingSyncState?.backfillCompletedAt ?? null,
        cooldownUntil: null,
        lastSuccessfulSyncAt: now,
        lastAttemptedSyncAt: now,
        lastErrorAt: null,
        lastErrorMessage: null,
      });
    }),
  );
}
