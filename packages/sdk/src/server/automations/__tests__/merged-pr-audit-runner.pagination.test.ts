import { randomUUID } from 'node:crypto';

import {
  asc,
  db,
  eq,
  inArray,
  pullRequestFacts,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

import {
  findAmbiguousRepositoryIdentities,
  getMergedPullRequests,
  type MergedPullRequest,
} from '../merged-pr-audit-runner';

/**
 * Real-database regression coverage for the merged-PR audit manifest:
 * repository-identity collisions (same full name across providers/hosts) and
 * page-boundary resume cursors with duplicate timestamps and PR numbers.
 */

const BATCH_LIMIT = 250;

const userIds: string[] = [];
const repositoryIds: string[] = [];

async function createUser() {
  const user = await userFactory.create({
    id: `user-${randomUUID()}`,
    email: `${randomUUID()}@example.com`,
  });
  userIds.push(user.id);
  return user;
}

async function createRepository(params: {
  linkedByUserId: string;
  fullName: string;
  provider: SourceControlProvider;
  host?: string;
  isActive?: boolean;
}) {
  const repository = await repositoryFactory.create({
    sourceControlProvider: params.provider,
    linkedByUserId: params.linkedByUserId,
    fullName: params.fullName,
    externalRepoId: randomUUID(),
    ...(params.host ? { host: params.host } : {}),
    ...(params.isActive === undefined ? {} : { isActive: params.isActive }),
  });
  repositoryIds.push(repository.id);
  return repository;
}

function manifestEntry(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  repositoryHost?: string | null;
  prNumber?: number;
}): MergedPullRequest {
  const prNumber = params.prNumber ?? 1;

  return {
    externalPullRequestId: prNumber,
    repositoryFullName: params.repositoryFullName,
    sourceControlProvider: params.provider,
    repositoryHost: params.repositoryHost ?? null,
    prNumber,
    title: `PR ${prNumber}`,
    htmlUrl: `https://example.com/${params.repositoryFullName}/pull-requests/${prNumber}`,
    mergedAt: new Date('2026-07-10T00:00:00Z'),
  };
}

async function insertMergedFacts(
  rows: Array<{
    repositoryId: string;
    repositoryFullName: string;
    provider: SourceControlProvider;
    prNumber: number;
    mergedAt: Date;
  }>,
) {
  const values = rows.map((row) => ({
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    sourceControlProvider: row.provider,
    // Mirrors Bitbucket/ADO, where the external id is the per-repository PR
    // number and therefore collides across repositories.
    externalPullRequestId: row.prNumber,
    prNumber: row.prNumber,
    title: `PR ${row.prNumber}`,
    htmlUrl: `https://example.com/${row.repositoryFullName}/pull-requests/${row.prNumber}`,
    state: 'merged' as const,
    createdAtRemote: row.mergedAt,
    updatedAtRemote: row.mergedAt,
    closedAtRemote: row.mergedAt,
    mergedAtRemote: row.mergedAt,
  }));

  for (let start = 0; start < values.length; start += 100) {
    await db.insert(pullRequestFacts).values(values.slice(start, start + 100));
  }
}

function manifestKeys(
  pullRequests: Array<{ repositoryFullName: string; prNumber: number }>,
) {
  return pullRequests.map(
    (pullRequest) =>
      `${pullRequest.repositoryFullName}#${pullRequest.prNumber}`,
  );
}

afterEach(async () => {
  if (repositoryIds.length > 0) {
    await db
      .delete(repositories)
      .where(inArray(repositories.id, repositoryIds));
    repositoryIds.length = 0;
  }

  while (userIds.length > 0) {
    const userId = userIds.pop()!;
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('getMergedPullRequests', () => {
  it('keeps same-name PRs from different providers as distinct manifest entries', async () => {
    const user = await createUser();
    const fullName = `acme/shared-${randomUUID()}`;
    const gitlabRepo = await createRepository({
      linkedByUserId: user.id,
      fullName,
      provider: 'gitlab',
    });
    const bitbucketRepo = await createRepository({
      linkedByUserId: user.id,
      fullName,
      provider: 'bitbucket',
    });

    const mergedAt = new Date('2026-07-10T00:00:00Z');
    await insertMergedFacts([
      {
        repositoryId: gitlabRepo.id,
        repositoryFullName: fullName,
        provider: 'gitlab',
        prNumber: 7,
        mergedAt,
      },
      {
        repositoryId: bitbucketRepo.id,
        repositoryFullName: fullName,
        provider: 'bitbucket',
        prNumber: 7,
        mergedAt,
      },
    ]);

    const batch = await getMergedPullRequests(
      { kind: 'interval', since: new Date('2026-07-09T00:00:00Z') },
      new Date('2026-07-11T00:00:00Z'),
    );

    // Both rows share repositoryFullName + prNumber; only the repository id
    // distinguishes them, so a fullName-keyed dedupe would drop one PR.
    expect(batch.pullRequests).toHaveLength(2);
    expect(batch.hasMore).toBe(false);

    // Each manifest entry carries its provider so the audit scheduler can
    // partition the manifest into one provider-stamped task per provider.
    expect(
      batch.pullRequests
        .map((pullRequest) => pullRequest.sourceControlProvider)
        .sort(),
    ).toEqual(['bitbucket', 'gitlab']);
  });

  it('carries each entry repository host so the scheduler can partition by (provider, host)', async () => {
    const user = await createUser();
    const fullName = `acme/self-managed-${randomUUID()}`;
    const hostA = 'gitlab.host-a.example';
    const hostB = 'gitlab.host-b.example';
    const repoA = await createRepository({
      linkedByUserId: user.id,
      fullName,
      provider: 'gitlab',
      host: hostA,
    });
    const repoB = await createRepository({
      linkedByUserId: user.id,
      fullName,
      provider: 'gitlab',
      host: hostB,
    });

    const mergedAt = new Date('2026-07-10T00:00:00Z');
    await insertMergedFacts([
      {
        repositoryId: repoA.id,
        repositoryFullName: fullName,
        provider: 'gitlab',
        prNumber: 3,
        mergedAt,
      },
      {
        repositoryId: repoB.id,
        repositoryFullName: fullName,
        provider: 'gitlab',
        prNumber: 3,
        mergedAt,
      },
    ]);

    const batch = await getMergedPullRequests(
      { kind: 'interval', since: new Date('2026-07-09T00:00:00Z') },
      new Date('2026-07-11T00:00:00Z'),
    );

    // Same provider, same fullName, same PR number: only the host (via the
    // repository row) distinguishes the two entries.
    expect(batch.pullRequests).toHaveLength(2);
    expect(
      batch.pullRequests
        .map((pullRequest) => pullRequest.repositoryHost)
        .sort(),
    ).toEqual([hostA, hostB]);
  });

  it('flags (provider, fullName) pairs active on multiple hosts as ambiguous', async () => {
    const user = await createUser();
    const sharedName = `acme/shared-${randomUUID()}`;
    const uniqueName = `acme/unique-${randomUUID()}`;

    await createRepository({
      linkedByUserId: user.id,
      fullName: sharedName,
      provider: 'gitlab',
      host: 'gitlab.host-a.example',
    });
    await createRepository({
      linkedByUserId: user.id,
      fullName: sharedName,
      provider: 'gitlab',
      host: 'gitlab.host-b.example',
    });
    await createRepository({
      linkedByUserId: user.id,
      fullName: uniqueName,
      provider: 'gitlab',
      host: 'gitlab.host-a.example',
    });
    // An inactive same-name row is not a resolution hazard: the launched
    // task's repository lookup only considers active rows.
    await createRepository({
      linkedByUserId: user.id,
      fullName: uniqueName,
      provider: 'gitlab',
      host: 'gitlab.host-b.example',
      isActive: false,
    });

    // The shared-name manifest entry references host A only; the host B twin
    // has no PRs in the window but still makes (provider, fullName)
    // resolution ambiguous for the launched task.
    const ambiguous = await findAmbiguousRepositoryIdentities([
      manifestEntry({
        provider: 'gitlab',
        repositoryFullName: sharedName,
        repositoryHost: 'gitlab.host-a.example',
      }),
      manifestEntry({
        provider: 'gitlab',
        repositoryFullName: uniqueName,
        repositoryHost: 'gitlab.host-a.example',
        prNumber: 2,
      }),
    ]);

    expect(ambiguous).toEqual(new Set([`gitlab\u0000${sharedName}`]));
  });

  it('resumes past a page boundary with duplicate timestamps and PR numbers', async () => {
    const user = await createUser();
    const suffix = randomUUID();
    const repoA = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/app-a-${suffix}`,
      provider: 'bitbucket',
    });
    const repoB = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/app-b-${suffix}`,
      provider: 'bitbucket',
    });

    const base = new Date('2026-07-01T00:00:00Z').getTime();
    const boundaryMergedAt = new Date(base + BATCH_LIMIT * 60_000);

    // Rows 1..(BATCH_LIMIT - 1) in repo A with strictly increasing merge
    // times, then two rows sharing the same merge timestamp AND the same PR
    // number (Bitbucket-style per-repo ids) in repos A and B. One of them is
    // the last row of page one; the other must survive onto page two.
    await insertMergedFacts([
      ...Array.from({ length: BATCH_LIMIT - 1 }, (_, index) => ({
        repositoryId: repoA.id,
        repositoryFullName: repoA.fullName,
        provider: 'bitbucket' as const,
        prNumber: index + 1,
        mergedAt: new Date(base + (index + 1) * 60_000),
      })),
      {
        repositoryId: repoA.id,
        repositoryFullName: repoA.fullName,
        provider: 'bitbucket',
        prNumber: BATCH_LIMIT,
        mergedAt: boundaryMergedAt,
      },
      {
        repositoryId: repoB.id,
        repositoryFullName: repoB.fullName,
        provider: 'bitbucket',
        prNumber: BATCH_LIMIT,
        mergedAt: boundaryMergedAt,
      },
    ]);

    const scanUpperBound = new Date(base + (BATCH_LIMIT + 10) * 60_000);
    const firstPage = await getMergedPullRequests(
      { kind: 'interval', since: new Date(base) },
      scanUpperBound,
    );

    expect(firstPage.pullRequests).toHaveLength(BATCH_LIMIT);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.nextCursor!.factId).toBeTruthy();
    expect(firstPage.nextCursor!.mergedAt).toBe(boundaryMergedAt.toISOString());

    const secondPage = await getMergedPullRequests(
      {
        kind: 'resume',
        cursor: firstPage.nextCursor!,
        cursorDate: new Date(firstPage.nextCursor!.mergedAt),
      },
      scanUpperBound,
    );

    expect(secondPage.pullRequests).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);

    // Nothing skipped, nothing audited twice: the two pages together cover
    // all 251 distinct PRs exactly once.
    const seen = [
      ...manifestKeys(firstPage.pullRequests),
      ...manifestKeys(secondPage.pullRequests),
    ];
    expect(new Set(seen).size).toBe(BATCH_LIMIT + 1);
  });

  it('treats a legacy cursor without factId as a timestamp-only resume', async () => {
    const user = await createUser();
    const suffix = randomUUID();
    const repoA = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/app-a-${suffix}`,
      provider: 'bitbucket',
    });
    const repoB = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/app-b-${suffix}`,
      provider: 'bitbucket',
    });

    // Keep this legacy-cursor fixture outside the historical windows used by
    // the other real-database suites, which run concurrently in Vitest.
    const mergedAt = new Date('2099-07-10T00:00:00Z');
    await insertMergedFacts([
      {
        repositoryId: repoA.id,
        repositoryFullName: repoA.fullName,
        provider: 'bitbucket',
        prNumber: 5,
        mergedAt,
      },
      {
        repositoryId: repoB.id,
        repositoryFullName: repoB.fullName,
        provider: 'bitbucket',
        prNumber: 5,
        mergedAt,
      },
    ]);

    // A pre-factId cursor pointing at this timestamp and PR number: the old
    // tie-breaker (externalPullRequestId > 5) would skip both rows forever.
    const batch = await getMergedPullRequests(
      {
        kind: 'resume',
        cursor: { mergedAt: mergedAt.toISOString(), externalPullRequestId: 5 },
        cursorDate: mergedAt,
      },
      new Date('2099-07-11T00:00:00Z'),
    );

    expect(manifestKeys(batch.pullRequests).sort()).toEqual([
      `${repoA.fullName}#5`,
      `${repoB.fullName}#5`,
    ]);
  });

  it('resumes strictly after the cursor row when factId is present', async () => {
    const user = await createUser();
    const suffix = randomUUID();
    const repoA = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/app-a-${suffix}`,
      provider: 'bitbucket',
    });
    const repoB = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/app-b-${suffix}`,
      provider: 'bitbucket',
    });

    const mergedAt = new Date('2026-07-10T00:00:00Z');
    await insertMergedFacts([
      {
        repositoryId: repoA.id,
        repositoryFullName: repoA.fullName,
        provider: 'bitbucket',
        prNumber: 5,
        mergedAt,
      },
      {
        repositoryId: repoB.id,
        repositoryFullName: repoB.fullName,
        provider: 'bitbucket',
        prNumber: 5,
        mergedAt,
      },
    ]);

    // Scan order tie-breaks on the facts row id, so a cursor at the
    // first-ordered row must return exactly the second-ordered row.
    const orderedRows = await db
      .select({
        factId: pullRequestFacts.id,
        repositoryFullName: pullRequestFacts.repositoryFullName,
        prNumber: pullRequestFacts.prNumber,
      })
      .from(pullRequestFacts)
      .where(inArray(pullRequestFacts.repositoryId, [repoA.id, repoB.id]))
      .orderBy(asc(pullRequestFacts.mergedAtRemote), asc(pullRequestFacts.id));

    const [firstRow, secondRow] = orderedRows;

    const batch = await getMergedPullRequests(
      {
        kind: 'resume',
        cursor: {
          mergedAt: mergedAt.toISOString(),
          factId: firstRow!.factId,
          externalPullRequestId: 5,
        },
        cursorDate: mergedAt,
      },
      new Date('2026-07-11T00:00:00Z'),
    );

    expect(manifestKeys(batch.pullRequests)).toEqual([
      `${secondRow!.repositoryFullName}#${secondRow!.prNumber}`,
    ]);
  });
});
