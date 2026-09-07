import { randomUUID } from 'node:crypto';

import { vi } from 'vitest';

import {
  db,
  eq,
  inArray,
  pullRequestFacts,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

import { enrichPullRequestFacts } from '../pull-request-facts-enrichment';
import { upsertPullRequestFacts } from '../pull-request-facts-store';

/**
 * Real-database coverage for the budgeted enrichment pass: what it picks,
 * what it writes, and how it backs off.
 */
const repositoryIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  if (repositoryIds.length > 0) {
    await db
      .delete(pullRequestFacts)
      .where(inArray(pullRequestFacts.repositoryId, repositoryIds));
    await db
      .delete(repositories)
      .where(inArray(repositories.id, repositoryIds.splice(0)));
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
  }
});

async function seedRepository() {
  const user = await userFactory.create({
    id: `user-${randomUUID()}`,
    email: `${randomUUID()}@example.com`,
  });
  userIds.push(user.id);
  const repository = await repositoryFactory.create({
    sourceControlProvider: 'gitlab',
    linkedByUserId: user.id,
    fullName: `acme/backend-${randomUUID()}`,
    host: 'gitlab.example.com',
    externalRepoId: randomUUID(),
  });
  repositoryIds.push(repository.id);
  return repository;
}

function snapshot(number: number, mergedAt: string | null) {
  return {
    authorLogin: 'octocat',
    closedAt: mergedAt,
    createdAt: '2026-07-01T00:00:00Z',
    externalPullRequestId: 900 + number,
    mergedAt,
    number,
    state: mergedAt ? ('merged' as const) : ('open' as const),
    title: `PR ${number}`,
    updatedAt: '2026-07-10T00:00:00Z',
    url: `https://gitlab.example.com/acme/backend/-/merge_requests/${number}`,
  };
}

async function rowsFor(repositoryId: string) {
  return db
    .select({
      prNumber: pullRequestFacts.prNumber,
      changedFiles: pullRequestFacts.changedFiles,
      changedFileCount: pullRequestFacts.changedFileCount,
      additions: pullRequestFacts.additions,
      deletions: pullRequestFacts.deletions,
      reviews: pullRequestFacts.reviews,
      enrichedAt: pullRequestFacts.enrichedAt,
      enrichedForUpdatedAt: pullRequestFacts.enrichedForUpdatedAt,
      enrichmentFailedAt: pullRequestFacts.enrichmentFailedAt,
      filesCapped: pullRequestFacts.filesCapped,
      updatedAt: pullRequestFacts.updatedAt,
    })
    .from(pullRequestFacts)
    .where(eq(pullRequestFacts.repositoryId, repositoryId))
    .orderBy(pullRequestFacts.prNumber);
}

/** PR numbers the pass read for one repository, ignoring other suites' rows. */
function callsForRepository(
  read: {
    mock: { calls: Array<[{ repository: { id: string }; prNumber: number }]> };
  },
  repositoryId: string,
): number[] {
  return read.mock.calls
    .filter((call) => call[0].repository.id === repositoryId)
    .map((call) => call[0].prNumber);
}

describe('enrichPullRequestFacts', () => {
  it('enriches due rows merged-first within the budget and bumps updatedAt', async () => {
    const repository = await seedRepository();
    const syncedAt = new Date('2026-07-10T01:00:00Z');
    await upsertPullRequestFacts({
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      sourceControlProvider: 'gitlab',
      syncedAt,
      pullRequests: [
        snapshot(1, null),
        snapshot(2, '2099-01-02T00:00:00Z'),
        snapshot(3, '2099-01-03T00:00:00Z'),
      ],
    });
    const read = vi.fn(
      async ({
        prNumber,
      }: {
        prNumber: number;
        repository: { id: string };
      }) => ({
        files: [
          {
            path: `src/pr${prNumber}.ts`,
            status: 'modified',
            additions: 2,
            deletions: 1,
          },
        ],
        filesTruncated: false,
        reviewsTruncated: false,
        reviews: [{ login: 'grace', state: 'approved' as const }],
      }),
    );
    const now = new Date('2026-07-11T00:00:00Z');

    const result = await enrichPullRequestFacts({ now, budget: 2, read });

    // Merged PRs first, newest merge first: #3 then #2; #1 waits.
    expect(read.mock.calls.map((call) => call[0].prNumber)).toEqual([3, 2]);
    expect(result).toEqual({
      attempted: 2,
      enriched: 2,
      failed: 0,
      rateLimited: false,
    });
    const rows = await rowsFor(repository.id);
    expect(rows[2]).toMatchObject({
      prNumber: 3,
      changedFiles: ['src/pr3.ts'],
      changedFileCount: 1,
      additions: 2,
      deletions: 1,
      reviews: [{ login: 'grace', state: 'approved' }],
      enrichedAt: now,
      enrichedForUpdatedAt: new Date('2026-07-10T00:00:00Z'),
      // The Brain's PR-facts sync walks updatedAt; the bump re-posts the page.
      updatedAt: now,
    });
    expect(rows[0]?.enrichedAt).toBeNull();

    // A second pass picks up only what is still due.
    read.mockClear();
    await enrichPullRequestFacts({ now, budget: 10, read });
    expect(callsForRepository(read, repository.id)).toEqual([1]);
  });

  it('re-enriches a row whose remote update moved, without a retry hold', async () => {
    // A successful pass must not park the row: gating on every attempt left
    // enrichedForUpdatedAt stale while the hold blocked the next pass.
    const repository = await seedRepository();
    const base = {
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      sourceControlProvider: 'gitlab' as const,
      syncedAt: new Date('2026-07-10T01:00:00Z'),
    };
    await upsertPullRequestFacts({
      ...base,
      pullRequests: [snapshot(1, '2099-02-01T00:00:00Z')],
    });
    const read = vi.fn(
      async (_input: { repository: { id: string }; prNumber: number }) => ({
        files: [],
        filesTruncated: false,
        reviewsTruncated: false,
        reviews: [],
      }),
    );

    await enrichPullRequestFacts({
      now: new Date('2026-07-11T00:00:00Z'),
      budget: 10,
      read,
    });
    expect(callsForRepository(read, repository.id)).toEqual([1]);

    // The PR changed upstream a minute later.
    await upsertPullRequestFacts({
      ...base,
      syncedAt: new Date('2026-07-11T00:01:00Z'),
      pullRequests: [
        {
          ...snapshot(1, '2099-02-01T00:00:00Z'),
          updatedAt: '2099-02-02T00:00:00Z',
        },
      ],
    });

    read.mockClear();
    await enrichPullRequestFacts({
      now: new Date('2026-07-11T00:02:00Z'),
      budget: 10,
      read,
    });

    // Well within the six-hour window, yet picked up again.
    expect(callsForRepository(read, repository.id)).toEqual([1]);
  });

  it('records a capped file listing as a lower bound', async () => {
    const repository = await seedRepository();
    await upsertPullRequestFacts({
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      sourceControlProvider: 'gitlab',
      syncedAt: new Date('2026-07-10T01:00:00Z'),
      pullRequests: [snapshot(1, '2099-03-01T00:00:00Z')],
    });
    const read = vi.fn(
      async (_input: { repository: { id: string }; prNumber: number }) => ({
        files: Array.from({ length: 300 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          status: 'modified',
          additions: 1,
          deletions: 0,
        })),
        filesTruncated: true,
        reviewsTruncated: false,
        reviews: [],
      }),
    );

    await enrichPullRequestFacts({
      now: new Date('2026-07-11T00:00:00Z'),
      budget: 10,
      read,
    });

    const [row] = await rowsFor(repository.id);
    // The count is what was READ (a lower bound), never null: storing null
    // let the page fall back to the 40 stored paths and claim "40 files".
    expect(row).toMatchObject({ changedFileCount: 300, filesCapped: true });
    expect(row?.changedFiles).toHaveLength(40);
  });

  it('holds a failed row for a while and stops the pass on rate limiting', async () => {
    const repository = await seedRepository();
    await upsertPullRequestFacts({
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      sourceControlProvider: 'gitlab',
      syncedAt: new Date('2026-07-10T01:00:00Z'),
      // Far-future merges so these rows sort ahead of whatever sibling
      // real-DB suites left behind: the pass scans every repository.
      pullRequests: [
        snapshot(1, '2099-01-09T00:00:00Z'),
        snapshot(2, '2099-01-08T00:00:00Z'),
      ],
    });
    // Scoped to this repository rather than "the first call" for the same
    // reason; other repositories' rows resolve normally.
    let rejected = false;
    const read = vi.fn(
      async ({
        repository: candidateRepository,
      }: {
        repository: { id: string };
        prNumber: number;
      }) => {
        if (candidateRepository.id === repository.id && !rejected) {
          rejected = true;
          throw new Error(
            'Source control API request failed: 429 Too Many Requests',
          );
        }
        return {
          files: [],
          filesTruncated: false,
          reviewsTruncated: false,
          reviews: [],
        };
      },
    );
    const now = new Date('2026-07-11T00:00:00Z');

    const result = await enrichPullRequestFacts({ now, budget: 10, read });

    // PR #1 (the newest merge) is this repository's first candidate; its 429
    // ends the pass, so #2 is never attempted.
    expect(result.rateLimited).toBe(true);
    expect(callsForRepository(read, repository.id)).toEqual([1]);
    const rows = await rowsFor(repository.id);
    expect(rows[0]).toMatchObject({
      enrichedAt: null,
      enrichmentFailedAt: now,
    });

    // Within the retry window the failed row is skipped; the other proceeds.
    read.mockClear();
    const soon = new Date(now.getTime() + 60 * 60 * 1000);
    await enrichPullRequestFacts({ now: soon, budget: 10, read });
    expect(callsForRepository(read, repository.id)).toEqual([2]);
  });
});
