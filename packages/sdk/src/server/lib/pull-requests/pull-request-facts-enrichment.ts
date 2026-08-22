import {
  and,
  db,
  eq,
  isNull,
  lt,
  or,
  pullRequestFacts,
  repositories,
  sql,
} from '@roomote/db/server';

import {
  readSourceControlPullRequestEnrichment,
  totalPullRequestLineChanges,
  type PullRequestEnrichment,
} from './source-control-pull-request-enrichment';
import type {
  FetchImpl,
  RepositoryRow,
} from './source-control-pull-request-shared';

const LOG_PREFIX = '[pullRequestFactsEnrichment]';

/**
 * Pull requests enriched per pass. Each costs one to three provider
 * requests; the pass runs on the hourly analytics sync, so this is the
 * steady-state ceiling on enrichment traffic and on how fast a backlog
 * drains (~1k PRs a day).
 */
const ENRICHMENT_BUDGET_PER_PASS = 40;
/** A failed read is not retried sooner than this. */
const ENRICHMENT_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** Paths stored per PR; the count and line totals stay exact regardless. */
export const STORED_CHANGED_FILE_CAP = 40;

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const status =
    'status' in error && typeof error.status === 'number' ? error.status : null;
  return (
    status === 403 ||
    status === 429 ||
    /Source control API request failed: (?:403|429)\b/.test(error.message)
  );
}

type EnrichmentCandidate = {
  id: string;
  prNumber: number;
  updatedAtRemote: Date;
  repository: RepositoryRow;
};

/**
 * Rows needing enrichment, merged PRs first (their file set is final and
 * they are what the Brain cites), then the most recently updated. A row is
 * due when it was never enriched or its remote update time moved past what
 * the enrichment reflects; a failed attempt holds it for a while.
 */
async function selectEnrichmentCandidates(
  now: Date,
  limit: number,
): Promise<EnrichmentCandidate[]> {
  const retryBefore = new Date(now.getTime() - ENRICHMENT_RETRY_AFTER_MS);
  const rows = await db
    .select({
      id: pullRequestFacts.id,
      prNumber: pullRequestFacts.prNumber,
      updatedAtRemote: pullRequestFacts.updatedAtRemote,
      mergedAtRemote: pullRequestFacts.mergedAtRemote,
      repositoryId: repositories.id,
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
      installationId: repositories.installationId,
      externalRepoId: repositories.externalRepoId,
      fullName: repositories.fullName,
      htmlUrl: repositories.htmlUrl,
    })
    .from(pullRequestFacts)
    .innerJoin(repositories, eq(repositories.id, pullRequestFacts.repositoryId))
    .where(
      and(
        eq(repositories.isActive, true),
        or(
          isNull(pullRequestFacts.enrichedForUpdatedAt),
          lt(
            pullRequestFacts.enrichedForUpdatedAt,
            pullRequestFacts.updatedAtRemote,
          ),
        ),
        or(
          isNull(pullRequestFacts.enrichmentAttemptedAt),
          lt(pullRequestFacts.enrichmentAttemptedAt, retryBefore),
        ),
      ),
    )
    .orderBy(
      sql`${pullRequestFacts.mergedAtRemote} DESC NULLS LAST`,
      sql`${pullRequestFacts.updatedAtRemote} DESC`,
    )
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    prNumber: row.prNumber,
    updatedAtRemote: row.updatedAtRemote,
    repository: {
      id: row.repositoryId,
      sourceControlProvider: row.sourceControlProvider,
      host: row.host,
      installationId: row.installationId,
      externalRepoId: row.externalRepoId,
      fullName: row.fullName,
      htmlUrl: row.htmlUrl,
    },
  }));
}

/**
 * Enrich a bounded batch of pull-request facts with files touched and
 * reviews. Bumps the row's local updatedAt so the Brain's PR-facts sync,
 * which walks that column, re-posts the page with the new sections.
 */
export async function enrichPullRequestFacts(
  params: {
    now?: Date;
    budget?: number;
    fetchImpl?: FetchImpl;
    read?: typeof readSourceControlPullRequestEnrichment;
  } = {},
): Promise<{
  attempted: number;
  enriched: number;
  failed: number;
  rateLimited: boolean;
}> {
  const now = params.now ?? new Date();
  const read = params.read ?? readSourceControlPullRequestEnrichment;
  const candidates = await selectEnrichmentCandidates(
    now,
    params.budget ?? ENRICHMENT_BUDGET_PER_PASS,
  );
  let enriched = 0;
  let failed = 0;

  for (const candidate of candidates) {
    let enrichment: PullRequestEnrichment;

    try {
      enrichment = await read({
        repository: candidate.repository,
        provider: candidate.repository.sourceControlProvider,
        prNumber: candidate.prNumber,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      });
    } catch (error) {
      failed += 1;
      await db
        .update(pullRequestFacts)
        .set({ enrichmentAttemptedAt: now })
        .where(eq(pullRequestFacts.id, candidate.id));
      console.warn(
        `${LOG_PREFIX} ${candidate.repository.fullName}#${candidate.prNumber} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (isRateLimitError(error)) {
        // The rest of the batch would only burn more of the same window.
        return {
          attempted: enriched + failed,
          enriched,
          failed,
          rateLimited: true,
        };
      }
      continue;
    }

    const totals = totalPullRequestLineChanges(enrichment.files);
    await db
      .update(pullRequestFacts)
      .set({
        changedFiles: enrichment.files
          .slice(0, STORED_CHANGED_FILE_CAP)
          .map((file) => file.path),
        changedFileCount: enrichment.filesTruncated
          ? null
          : enrichment.files.length,
        additions: totals.additions,
        deletions: totals.deletions,
        reviews: enrichment.reviews,
        enrichedAt: now,
        enrichedForUpdatedAt: candidate.updatedAtRemote,
        enrichmentAttemptedAt: now,
        updatedAt: now,
      })
      .where(eq(pullRequestFacts.id, candidate.id));
    enriched += 1;
  }

  if (candidates.length > 0) {
    console.log(
      `${LOG_PREFIX} enriched ${enriched}/${candidates.length} pull requests (${failed} failed)`,
    );
  }

  return { attempted: candidates.length, enriched, failed, rateLimited: false };
}
