import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  db,
  inArray,
  repositories,
  repositoryAutomationSignals,
  repositoryFactory,
  userFactory,
} from '@roomote/db/server';
import {
  AUTOMATION_SIGNALS_VERSION,
  type listOpenSourceControlPullRequestsForRepository,
} from '@roomote/sdk/server';
import type { RepositoryAutomationSignals } from '@roomote/types';

import { buildSetupRepoDigest } from './repo-digest';

type ListOpenPullRequests =
  typeof listOpenSourceControlPullRequestsForRepository;

const createdRepositoryIds: string[] = [];

afterAll(async () => {
  if (createdRepositoryIds.length > 0) {
    await db
      .delete(repositories)
      .where(inArray(repositories.id, createdRepositoryIds));
  }
});

async function createRepository() {
  const user = await userFactory.create();
  const repository = await repositoryFactory.create({
    sourceControlProvider: 'gitea',
    host: 'gitea.example.com',
    linkedByUserId: user.id,
    isActive: true,
  });
  createdRepositoryIds.push(repository.id);
  return repository;
}

function signalsPayload(
  repository: { id: string; fullName: string },
  overrides: Partial<RepositoryAutomationSignals> = {},
): RepositoryAutomationSignals {
  return {
    repositoryId: repository.id,
    repositoryName: repository.fullName,
    sourceControlProvider: 'gitea',
    // Large enough to rank ahead of any other repositories in the shared
    // test database.
    mergedPrs30d: 950,
    openPrs: 4,
    conflicts: 1,
    ciFailures30d: 9,
    dependabotAlerts: 2,
    codeqlAlerts: 0,
    dependencyManifests: 3,
    docs: 1,
    ...overrides,
  };
}

function fakeListing(pullRequests: unknown[]): ListOpenPullRequests {
  return vi
    .fn()
    .mockImplementation(
      async ({ repository }: { repository: { fullName: string } }) => ({
        success: true,
        provider: 'gitea',
        repositoryFullName: repository.fullName,
        pullRequests,
        warnings: [],
      }),
    ) as unknown as ListOpenPullRequests;
}

describe('buildSetupRepoDigest', () => {
  it('combines collected signals with live open PRs for the most active repositories', async () => {
    const repository = await createRepository();
    await db.insert(repositoryAutomationSignals).values({
      repositoryId: repository.id,
      signalsVersion: AUTOMATION_SIGNALS_VERSION,
      payload: signalsPayload(repository),
    });

    const nineDaysAgo = new Date(
      Date.now() - 9 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const digest = await buildSetupRepoDigest({
      listOpenPullRequests: fakeListing([
        {
          number: 42,
          title: 'Fix login timeout',
          createdAt: nineDaysAgo,
          draft: false,
        },
      ]),
    });

    const entry = digest.find((item) => item.name === repository.fullName);
    expect(entry).toMatchObject({
      provider: 'gitea',
      openPrCount: 4,
      mergedPrs30d: 950,
      ciFailures30d: 9,
      dependabotAlerts: 2,
      mergeConflicts: 1,
    });
    expect(entry?.openPrs).toEqual([
      { number: 42, untrustedTitle: 'Fix login timeout', ageDays: 9 },
    ]);
  });

  it('omits open PRs when listings exceed the time budget and never throws', async () => {
    const repository = await createRepository();
    await db.insert(repositoryAutomationSignals).values({
      repositoryId: repository.id,
      signalsVersion: AUTOMATION_SIGNALS_VERSION,
      payload: signalsPayload(repository, { mergedPrs30d: 951 }),
    });

    const neverResolves = vi
      .fn()
      .mockImplementation(
        () => new Promise(() => {}),
      ) as unknown as ListOpenPullRequests;

    const digest = await buildSetupRepoDigest({
      listOpenPullRequests: neverResolves,
      prListTimeoutMs: 50,
    });

    const entry = digest.find((item) => item.name === repository.fullName);
    expect(entry).toMatchObject({ ciFailures30d: 9 });
    expect(entry?.openPrs).toBeUndefined();
  });

  it('keeps signal facts when a single listing rejects', async () => {
    const repository = await createRepository();
    await db.insert(repositoryAutomationSignals).values({
      repositoryId: repository.id,
      signalsVersion: AUTOMATION_SIGNALS_VERSION,
      payload: signalsPayload(repository, { mergedPrs30d: 952 }),
    });

    const rejects = vi
      .fn()
      .mockRejectedValue(
        new Error('provider unavailable'),
      ) as unknown as ListOpenPullRequests;

    const digest = await buildSetupRepoDigest({
      listOpenPullRequests: rejects,
    });

    const entry = digest.find((item) => item.name === repository.fullName);
    expect(entry).toMatchObject({ openPrCount: 4 });
    expect(entry?.openPrs).toBeUndefined();
  });
});
