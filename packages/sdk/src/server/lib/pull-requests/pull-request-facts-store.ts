import {
  db,
  pullRequestFacts,
  pullRequestSyncStates,
  sql,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

/**
 * Shared persistence layer for the `pull_request_facts` +
 * `pull_request_sync_states` tables. The GitHub analytics sync and the
 * provider-neutral merged-PR sync both write through these helpers so row
 * shape and cursor semantics stay identical across providers.
 */

export type PullRequestFactSnapshot = {
  authorLogin: string | null;
  /** Null or absent means "not known to this writer", never "empty". */
  body?: string | null;
  labels?: string[] | null;
  closedAt: string | null;
  createdAt: string;
  externalPullRequestId: number;
  mergedAt: string | null;
  number: number;
  state: 'open' | 'draft' | 'closed' | 'merged';
  title: string;
  updatedAt: string;
  url: string;
};

export function getLatestUpdatedAt(
  pullRequests: PullRequestFactSnapshot[],
  fallback: Date | null,
): Date | null {
  return pullRequests.reduce((latest, pullRequest) => {
    const updatedAt = new Date(pullRequest.updatedAt);
    if (!latest || updatedAt > latest) {
      return updatedAt;
    }

    return latest;
  }, fallback);
}

export async function upsertPullRequestFacts(params: {
  repositoryId: string;
  repositoryFullName: string;
  sourceControlProvider: SourceControlProvider;
  pullRequests: PullRequestFactSnapshot[];
  syncedAt: Date;
}) {
  if (params.pullRequests.length === 0) {
    return;
  }

  await db
    .insert(pullRequestFacts)
    .values(
      params.pullRequests.map((pullRequest) => ({
        repositoryId: params.repositoryId,
        repositoryFullName: params.repositoryFullName,
        sourceControlProvider: params.sourceControlProvider,
        externalPullRequestId: pullRequest.externalPullRequestId,
        prNumber: pullRequest.number,
        title: pullRequest.title,
        htmlUrl: pullRequest.url,
        authorLogin: pullRequest.authorLogin,
        body: pullRequest.body ?? null,
        labels: pullRequest.labels ?? null,
        state: pullRequest.state,
        createdAtRemote: new Date(pullRequest.createdAt),
        updatedAtRemote: new Date(pullRequest.updatedAt),
        closedAtRemote: pullRequest.closedAt
          ? new Date(pullRequest.closedAt)
          : null,
        mergedAtRemote: pullRequest.mergedAt
          ? new Date(pullRequest.mergedAt)
          : null,
        syncedAt: params.syncedAt,
        updatedAt: params.syncedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [pullRequestFacts.repositoryId, pullRequestFacts.prNumber],
      set: {
        repositoryFullName: sql`excluded.repository_full_name`,
        sourceControlProvider: sql`excluded.source_control_provider`,
        externalPullRequestId: sql`excluded.external_pull_request_id`,
        title: sql`excluded.title`,
        htmlUrl: sql`excluded.html_url`,
        authorLogin: sql`excluded.author_login`,
        // A writer that does not know the body or labels (a webhook carrying
        // only its event's fields) must not erase what the list sync stored.
        body: sql`COALESCE(excluded.body, ${pullRequestFacts.body})`,
        labels: sql`COALESCE(excluded.labels, ${pullRequestFacts.labels})`,
        state: sql`excluded.state`,
        createdAtRemote: sql`excluded.created_at_remote`,
        updatedAtRemote: sql`excluded.updated_at_remote`,
        closedAtRemote: sql`excluded.closed_at_remote`,
        mergedAtRemote: sql`excluded.merged_at_remote`,
        syncedAt: params.syncedAt,
        updatedAt: params.syncedAt,
      },
    });
}

export async function upsertPullRequestSyncState(params: {
  repositoryId: string;
  lastIncrementalUpdatedAt?: Date | null;
  backfillCompletedAt?: Date | null;
  cooldownUntil?: Date | null;
  lastSuccessfulSyncAt?: Date | null;
  lastAttemptedSyncAt: Date;
  lastErrorAt?: Date | null;
  lastErrorMessage?: string | null;
}) {
  await db
    .insert(pullRequestSyncStates)
    .values({
      repositoryId: params.repositoryId,
      lastIncrementalUpdatedAt: params.lastIncrementalUpdatedAt ?? null,
      backfillCompletedAt: params.backfillCompletedAt ?? null,
      cooldownUntil: params.cooldownUntil ?? null,
      lastSuccessfulSyncAt: params.lastSuccessfulSyncAt ?? null,
      lastAttemptedSyncAt: params.lastAttemptedSyncAt,
      lastErrorAt: params.lastErrorAt ?? null,
      lastErrorMessage: params.lastErrorMessage ?? null,
      updatedAt: params.lastAttemptedSyncAt,
    })
    .onConflictDoUpdate({
      target: [pullRequestSyncStates.repositoryId],
      set: {
        lastIncrementalUpdatedAt: params.lastIncrementalUpdatedAt ?? null,
        backfillCompletedAt: params.backfillCompletedAt ?? null,
        cooldownUntil: params.cooldownUntil ?? null,
        lastSuccessfulSyncAt: params.lastSuccessfulSyncAt ?? null,
        lastAttemptedSyncAt: params.lastAttemptedSyncAt,
        lastErrorAt: params.lastErrorAt ?? null,
        lastErrorMessage: params.lastErrorMessage ?? null,
        updatedAt: params.lastAttemptedSyncAt,
      },
    });
}
