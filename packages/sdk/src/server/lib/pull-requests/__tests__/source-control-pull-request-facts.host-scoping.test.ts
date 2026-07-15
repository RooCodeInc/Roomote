import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  inArray,
  pullRequestFacts,
  pullRequestSyncStates,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

import { upsertSourceControlPullRequestFactFromWebhook } from '../source-control-pull-request-facts';

/**
 * Real-database regression coverage for repository-identity collisions: a
 * webhook fact upsert for group/repo on one self-managed host must not write
 * facts or sync cursors to an active same-name repository on another host.
 */

const NOW = new Date('2026-07-14T12:00:00Z');

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

async function createGitLabRepository(params: {
  linkedByUserId: string;
  fullName: string;
  host: string | null;
}) {
  const repository = await repositoryFactory.create({
    sourceControlProvider: 'gitlab',
    linkedByUserId: params.linkedByUserId,
    fullName: params.fullName,
    host: params.host,
    externalRepoId: randomUUID(),
  });
  repositoryIds.push(repository.id);
  return repository;
}

function makeSnapshot(host: string) {
  return {
    authorLogin: 'gitlab-user',
    closedAt: '2026-07-10T00:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
    externalPullRequestId: 900,
    mergedAt: '2026-07-10T00:00:00Z',
    number: 42,
    state: 'merged' as const,
    title: 'Update backend',
    updatedAt: '2026-07-10T00:00:00Z',
    url: `https://${host}/acme/backend/-/merge_requests/42`,
  };
}

async function factRowsFor(ids: string[]) {
  return db
    .select({
      repositoryId: pullRequestFacts.repositoryId,
      prNumber: pullRequestFacts.prNumber,
    })
    .from(pullRequestFacts)
    .where(inArray(pullRequestFacts.repositoryId, ids));
}

async function syncStateRowsFor(ids: string[]) {
  return db
    .select({ repositoryId: pullRequestSyncStates.repositoryId })
    .from(pullRequestSyncStates)
    .where(inArray(pullRequestSyncStates.repositoryId, ids));
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

describe('upsertSourceControlPullRequestFactFromWebhook host scoping', () => {
  it('writes facts and sync state only to the repository on the webhook host', async () => {
    const user = await createUser();
    const fullName = `acme/backend-${randomUUID()}`;
    const repoHostA = await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      host: 'gitlab.host-a.example.com',
    });
    const repoHostB = await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      host: 'gitlab.host-b.example.com',
    });

    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'gitlab',
      repositoryFullName: fullName,
      host: 'gitlab.host-a.example.com',
      pullRequest: makeSnapshot('gitlab.host-a.example.com'),
      now: NOW,
    });

    const factRows = await factRowsFor([repoHostA.id, repoHostB.id]);
    expect(factRows).toEqual([{ repositoryId: repoHostA.id, prNumber: 42 }]);

    const syncStates = await syncStateRowsFor([repoHostA.id, repoHostB.id]);
    expect(syncStates).toEqual([{ repositoryId: repoHostA.id }]);
  });

  it('still matches legacy repositories whose host has not been backfilled', async () => {
    const user = await createUser();
    const fullName = `acme/backend-${randomUUID()}`;
    const repoWithHost = await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      host: 'gitlab.host-a.example.com',
    });
    const legacyRepo = await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      host: null,
    });

    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'gitlab',
      repositoryFullName: fullName,
      host: 'gitlab.host-a.example.com',
      pullRequest: makeSnapshot('gitlab.host-a.example.com'),
      now: NOW,
    });

    const factRows = await factRowsFor([repoWithHost.id, legacyRepo.id]);
    expect(new Set(factRows.map((row) => row.repositoryId))).toEqual(
      new Set([repoWithHost.id, legacyRepo.id]),
    );
  });

  it('falls back to unscoped matching when the webhook host is unknown', async () => {
    const user = await createUser();
    const fullName = `acme/backend-${randomUUID()}`;
    const repoHostA = await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      host: 'gitlab.host-a.example.com',
    });
    const repoHostB = await createGitLabRepository({
      linkedByUserId: user.id,
      fullName,
      host: 'gitlab.host-b.example.com',
    });

    await upsertSourceControlPullRequestFactFromWebhook({
      provider: 'gitlab',
      repositoryFullName: fullName,
      pullRequest: makeSnapshot('gitlab.host-a.example.com'),
      now: NOW,
    });

    const factRows = await factRowsFor([repoHostA.id, repoHostB.id]);
    expect(new Set(factRows.map((row) => row.repositoryId))).toEqual(
      new Set([repoHostA.id, repoHostB.id]),
    );
  });
});
