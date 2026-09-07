import { randomUUID } from 'node:crypto';

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

import { upsertPullRequestFacts } from '../pull-request-facts-store';

/**
 * Real-database coverage for the body/labels merge rule: a writer that does
 * not know them (a webhook carrying only its event's fields) must not erase
 * what the list sync stored, while a writer that does know them replaces.
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

function snapshot(
  overrides: Partial<
    Parameters<typeof upsertPullRequestFacts>[0]['pullRequests'][number]
  > = {},
) {
  return {
    authorLogin: 'octocat',
    closedAt: '2026-07-10T00:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
    externalPullRequestId: 900,
    mergedAt: '2026-07-10T00:00:00Z',
    number: 42,
    state: 'merged' as const,
    title: 'Update backend',
    updatedAt: '2026-07-10T00:00:00Z',
    url: 'https://gitlab.example.com/acme/backend/-/merge_requests/42',
    ...overrides,
  };
}

describe('upsertPullRequestFacts body and labels', () => {
  it('keeps a known body and labels when a later writer does not carry them', async () => {
    const user = await userFactory.create({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
    });
    userIds.push(user.id);
    // GitLab rather than GitHub only because the GitHub factory row needs an
    // installation; the merge rule under test is provider-agnostic.
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      host: 'gitlab.example.com',
      externalRepoId: randomUUID(),
    });
    repositoryIds.push(repository.id);
    const base = {
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      sourceControlProvider: 'gitlab' as const,
      syncedAt: new Date('2026-07-10T01:00:00Z'),
    };

    // The list sync knows both.
    await upsertPullRequestFacts({
      ...base,
      pullRequests: [
        snapshot({ body: 'Why: the writer raced.', labels: ['bug'] }),
      ],
    });
    // A webhook-driven upsert knows neither: it must not erase them.
    await upsertPullRequestFacts({
      ...base,
      pullRequests: [snapshot({ title: 'Update backend (edited)' })],
    });

    let [row] = await db
      .select({
        title: pullRequestFacts.title,
        body: pullRequestFacts.body,
        labels: pullRequestFacts.labels,
      })
      .from(pullRequestFacts)
      .where(eq(pullRequestFacts.repositoryId, repository.id));
    expect(row).toEqual({
      title: 'Update backend (edited)',
      body: 'Why: the writer raced.',
      labels: ['bug'],
    });

    // A writer that does know them replaces, including clearing labels.
    await upsertPullRequestFacts({
      ...base,
      pullRequests: [snapshot({ body: 'Rewritten.', labels: [] })],
    });
    [row] = await db
      .select({
        title: pullRequestFacts.title,
        body: pullRequestFacts.body,
        labels: pullRequestFacts.labels,
      })
      .from(pullRequestFacts)
      .where(eq(pullRequestFacts.repositoryId, repository.id));
    expect(row).toEqual({
      title: 'Update backend',
      body: 'Rewritten.',
      labels: [],
    });
  });
});
