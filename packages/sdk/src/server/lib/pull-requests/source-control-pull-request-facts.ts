import {
  and,
  db,
  eq,
  inArray,
  isNull,
  or,
  pullRequestSyncStates,
  repositories,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

import {
  getLatestUpdatedAt,
  upsertPullRequestFacts,
  upsertPullRequestSyncState,
  type PullRequestFactSnapshot,
} from './pull-request-facts-store';
import {
  listMergedSourceControlPullRequestsForRepository,
  type SourceControlPullRequestSummary,
} from './source-control-pull-request-reads';
import type { RepositoryRow } from './source-control-pull-request-shared';

const LOG_PREFIX = '[sourceControlPullRequestFacts]';

const MAX_REPOSITORIES_PER_RUN = 8;
const MERGED_PULL_REQUEST_LIST_LIMIT = 200;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Providers covered by the merged-PR facts sync. GitHub is excluded: its
 * facts are written by the GitHub analytics sync
 * (github-pull-request-facts.ts), which also captures open/closed PRs.
 */
const FACTS_SYNC_PROVIDERS = [
  'gitlab',
  'gitea',
  'ado',
  'bitbucket',
] as const satisfies readonly SourceControlProvider[];

type FactsSyncProvider = (typeof FACTS_SYNC_PROVIDERS)[number];

function isFactsSyncProvider(
  provider: SourceControlProvider,
): provider is FactsSyncProvider {
  return (FACTS_SYNC_PROVIDERS as readonly SourceControlProvider[]).includes(
    provider,
  );
}

/**
 * Map a merged-state list summary to the shared facts snapshot.
 *
 * Field gaps by provider, resolved here so the row shape stays uniform:
 * - Bitbucket exposes no merge timestamp; `updatedAt` (the merge activity
 *   time on a MERGED PR) stands in for `mergedAt`/`closedAt`.
 * - Azure DevOps lists carry no last-updated timestamp; `closedDate`
 *   (surfaced as the summary's `mergedAt`) stands in for `updatedAt`.
 * - `externalId` falls back to the per-repository number for providers
 *   without a separate global id (Bitbucket, ADO); uniqueness is enforced
 *   on (repositoryId, prNumber) so this only affects cursor tie-breaks.
 */
function toMergedPullRequestFactSnapshot(
  summary: SourceControlPullRequestSummary,
  now: Date,
): PullRequestFactSnapshot | null {
  if (summary.state !== 'merged') {
    return null;
  }

  const mergedAt = summary.mergedAt ?? summary.updatedAt ?? now.toISOString();
  const updatedAt = summary.updatedAt ?? mergedAt;
  const createdAt = summary.createdAt ?? mergedAt;

  return {
    authorLogin: summary.author?.login ?? null,
    closedAt: summary.closedAt ?? mergedAt,
    createdAt,
    externalPullRequestId: summary.externalId ?? summary.number,
    mergedAt,
    number: summary.number,
    state: 'merged',
    title: summary.title,
    updatedAt,
    url: summary.url,
  };
}

/**
 * The provider read helpers surface HTTP failures as
 * `Source control API request failed: <status> ...` errors without response
 * headers, so rate limiting maps to a fixed cooldown rather than the
 * retry-after-driven one the GitHub sync computes.
 */
function getRateLimitCooldownUntil(error: unknown, now: Date): Date | null {
  if (!(error instanceof Error)) {
    return null;
  }

  return /Source control API request failed: (?:403|429)\b/.test(error.message)
    ? new Date(now.getTime() + RATE_LIMIT_COOLDOWN_MS)
    : null;
}

async function syncRepositoryMergedPullRequestFacts(params: {
  repository: RepositoryRow;
  backfillCompletedAt: Date | null;
  lastIncrementalUpdatedAt: Date | null;
  now: Date;
}): Promise<
  | { success: true; pullRequests: number }
  | { success: false; cooldownUntil: Date | null; error: string }
> {
  const { repository, now } = params;

  try {
    // Backfill and incremental passes share the same bounded merged-PR list;
    // the incremental pass narrows it to PRs updated after the cursor.
    const listResult = await listMergedSourceControlPullRequestsForRepository({
      repository,
      provider: repository.sourceControlProvider,
      limit: MERGED_PULL_REQUEST_LIST_LIMIT,
      updatedAfter: params.backfillCompletedAt
        ? params.lastIncrementalUpdatedAt
        : null,
    });

    const pullRequests = listResult.pullRequests
      .map((summary) => toMergedPullRequestFactSnapshot(summary, now))
      .filter(
        (snapshot): snapshot is PullRequestFactSnapshot => snapshot !== null,
      );

    await upsertPullRequestFacts({
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      sourceControlProvider: repository.sourceControlProvider,
      pullRequests,
      syncedAt: now,
    });

    const latestUpdatedAt =
      getLatestUpdatedAt(pullRequests, params.lastIncrementalUpdatedAt) ?? now;

    await upsertPullRequestSyncState({
      repositoryId: repository.id,
      lastIncrementalUpdatedAt: latestUpdatedAt,
      backfillCompletedAt: params.backfillCompletedAt ?? now,
      cooldownUntil: null,
      lastSuccessfulSyncAt: now,
      lastAttemptedSyncAt: now,
      lastErrorAt: null,
      lastErrorMessage: null,
    });

    return { success: true, pullRequests: pullRequests.length };
  } catch (error) {
    const cooldownUntil = getRateLimitCooldownUntil(error, now);

    await upsertPullRequestSyncState({
      repositoryId: repository.id,
      lastIncrementalUpdatedAt: params.lastIncrementalUpdatedAt,
      backfillCompletedAt: params.backfillCompletedAt,
      cooldownUntil,
      lastSuccessfulSyncAt: null,
      lastAttemptedSyncAt: now,
      lastErrorAt: now,
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      cooldownUntil,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sync merged-PR facts for every active non-GitHub repository, mirroring the
 * GitHub analytics sync's per-repository budget, cooldowns, and
 * least-recently-synced ordering. Only merged PRs are ingested: the
 * merged-PR audit automations are the consumer, and they filter on
 * state='merged' with a mergedAtRemote cursor.
 */
export async function syncSourceControlPullRequestFacts(params?: {
  now?: Date;
}) {
  const now = params?.now ?? new Date();

  const repositoryRows = await db
    .select({
      id: repositories.id,
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
      installationId: repositories.installationId,
      externalRepoId: repositories.externalRepoId,
      fullName: repositories.fullName,
      htmlUrl: repositories.htmlUrl,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.isActive, true),
        inArray(repositories.sourceControlProvider, [...FACTS_SYNC_PROVIDERS]),
      ),
    );

  if (repositoryRows.length === 0) {
    return {
      eligibleRepositories: 0,
      processedRepositories: 0,
      failedRepositories: 0,
      cooledDownRepositories: 0,
    };
  }

  const syncStateRows = await db
    .select()
    .from(pullRequestSyncStates)
    .where(
      inArray(
        pullRequestSyncStates.repositoryId,
        repositoryRows.map((repository) => repository.id),
      ),
    );
  const syncStateByRepositoryId = new Map(
    syncStateRows.map((syncState) => [syncState.repositoryId, syncState]),
  );

  const repositoriesToProcess = repositoryRows
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
    })
    .slice(0, MAX_REPOSITORIES_PER_RUN);

  let processedRepositories = 0;
  let failedRepositories = 0;
  let cooledDownRepositories = 0;

  for (const repository of repositoriesToProcess) {
    const syncState = syncStateByRepositoryId.get(repository.id);
    const result = await syncRepositoryMergedPullRequestFacts({
      repository,
      backfillCompletedAt: syncState?.backfillCompletedAt ?? null,
      lastIncrementalUpdatedAt: syncState?.lastIncrementalUpdatedAt ?? null,
      now,
    });

    if (result.success) {
      processedRepositories += 1;
      continue;
    }

    failedRepositories += 1;
    console.error(
      `${LOG_PREFIX} Failed to sync ${repository.sourceControlProvider} repository ${repository.fullName}: ${result.error}`,
    );

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

/**
 * Upsert one PR fact from a provider webhook so merges are visible to the
 * merged-PR audit automations without waiting for the next sync pass.
 * Mirrors upsertGitHubPullRequestFactFromWebhook, keyed by
 * (provider, host, repository full name) since non-GitHub webhooks carry no
 * installation-scoped repo id. Without the host, a terminal event for
 * group/repo on one self-managed instance would write facts and sync cursors
 * to every active same-name repository on other instances.
 */
export async function upsertSourceControlPullRequestFactFromWebhook(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  /**
   * Source-control instance host the webhook came from (for example
   * `gitlab.example.com`), matching `repositories.host` as written by the
   * provider repository sync (`new URL(baseUrl).host`). Rows with a NULL
   * host (not yet backfilled) still match so legacy repositories keep
   * receiving webhook facts. When omitted, matching falls back to
   * (provider, full name) alone.
   */
  host?: string | null;
  pullRequest: PullRequestFactSnapshot;
  now?: Date;
}) {
  if (!isFactsSyncProvider(params.provider)) {
    return;
  }

  const now = params.now ?? new Date();

  const matchingRepositories = await db
    .select({
      repositoryId: repositories.id,
      repositoryFullName: repositories.fullName,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.sourceControlProvider, params.provider),
        eq(repositories.fullName, params.repositoryFullName),
        eq(repositories.isActive, true),
        params.host
          ? or(eq(repositories.host, params.host), isNull(repositories.host))
          : undefined,
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
        sourceControlProvider: params.provider,
        pullRequests: [params.pullRequest],
        syncedAt: now,
      });

      await upsertPullRequestSyncState({
        repositoryId: repository.repositoryId,
        lastIncrementalUpdatedAt,
        backfillCompletedAt: existingSyncState?.backfillCompletedAt ?? null,
        cooldownUntil: existingSyncState?.cooldownUntil ?? null,
        lastSuccessfulSyncAt: now,
        lastAttemptedSyncAt: now,
        lastErrorAt: null,
        lastErrorMessage: null,
      });
    }),
  );
}
