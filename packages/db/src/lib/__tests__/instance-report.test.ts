import { and, eq, inArray, notInArray } from 'drizzle-orm';

import { SOURCE_CONTROL_AUTOMATION_WORKFLOWS } from '@roomote/types';

import {
  db,
  githubInstallationFactory,
  pullRequestFacts,
  repositoryFactory,
  taskFactory,
  taskPullRequests,
  tasks,
  userFactory,
} from '../../server';
import {
  bucketPullRequestStatus,
  collectInstanceReportStats,
  dedupeAuthoredPullRequests,
  median,
  summarizePullRequestCohort,
} from '../instance-report';

describe('instance-report pure helpers', () => {
  it('buckets draft and null into open, closed and merged distinctly', () => {
    expect(bucketPullRequestStatus('draft')).toBe('open');
    expect(bucketPullRequestStatus('open')).toBe('open');
    expect(bucketPullRequestStatus(null)).toBe('open');
    expect(bucketPullRequestStatus('closed')).toBe('closed');
    expect(bucketPullRequestStatus('merged')).toBe('merged');
  });

  it('computes the sample median, rounding even-length midpoints', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3, 5])).toBe(3);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('dedupes by repo#number using earliest detection and latest status', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    const earlier = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const later = new Date(now.getTime() + 60 * 60 * 1000);

    const deduped = dedupeAuthoredPullRequests([
      {
        sourceControlProvider: 'github',
        host: 'github.com',
        repository: 'Acme/App',
        repositoryId: 'repo-1',
        prNumber: 7,
        prUrl: 'https://github.com/Acme/App/pull/7',
        status: 'open',
        detectedAt: earlier,
        updatedAt: earlier,
      },
      {
        sourceControlProvider: 'github',
        host: 'github.com',
        repository: 'acme/app',
        repositoryId: 'repo-1',
        prNumber: 7,
        prUrl: 'https://github.com/Acme/App/pull/7',
        status: 'merged',
        detectedAt: later,
        updatedAt: later,
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({
      firstDetectedAt: earlier,
      status: 'merged',
      repositoryId: 'repo-1',
      prNumber: 7,
    });
  });

  it('summarizes the 7d cohort including non-fact merge durations when provided', () => {
    const since = new Date('2026-07-01T00:00:00.000Z');
    const inWindow = new Date('2026-07-05T00:00:00.000Z');
    const beforeWindow = new Date('2026-06-20T00:00:00.000Z');

    const result = summarizePullRequestCohort(
      [
        {
          key: 'github:github.com:acme/app#1',
          sourceControlProvider: 'github',
          host: 'github.com',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 1,
          status: 'open',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:github.com:acme/app#2',
          sourceControlProvider: 'github',
          host: 'github.com',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 2,
          status: 'draft',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:github.com:acme/app#3',
          sourceControlProvider: 'github',
          host: 'github.com',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 3,
          status: 'closed',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:github.com:acme/app#4',
          sourceControlProvider: 'github',
          host: 'github.com',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 4,
          status: 'merged',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:github.com:acme/app#5',
          sourceControlProvider: 'github',
          host: 'github.com',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 5,
          status: 'merged',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:github.com:acme/app#old',
          sourceControlProvider: 'github',
          host: 'github.com',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 99,
          status: 'merged',
          firstDetectedAt: beforeWindow,
        },
      ],
      since,
      new Map([
        ['github:github.com:acme/app#4', 100],
        ['github:github.com:acme/app#5', 300],
      ]),
    );

    expect(result).toEqual({
      opened: 5,
      open: 2,
      closed: 1,
      merged: 2,
      medianTimeToMergeSeconds: 200,
    });
  });

  it('keeps same-named repos on different hosts as distinct PR keys', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');

    const deduped = dedupeAuthoredPullRequests([
      {
        sourceControlProvider: 'gitlab',
        host: 'gitlab.a.example',
        repository: 'acme/app',
        repositoryId: 'repo-a',
        prNumber: 3,
        prUrl: 'https://gitlab.a.example/acme/app/-/merge_requests/3',
        status: 'open',
        detectedAt: now,
        updatedAt: now,
      },
      {
        sourceControlProvider: 'gitlab',
        host: 'gitlab.b.example',
        repository: 'acme/app',
        repositoryId: 'repo-b',
        prNumber: 3,
        prUrl: 'https://gitlab.b.example/acme/app/-/merge_requests/3',
        status: 'merged',
        detectedAt: now,
        updatedAt: now,
      },
    ]);

    expect(deduped).toHaveLength(2);
    expect(new Set(deduped.map((entry) => entry.key)).size).toBe(2);
  });
});

describe('collectInstanceReportStats pullRequests7d isolation', () => {
  it('includes product-opened associations and kicks automation-linked rows out', async () => {
    // Scope assertions to this fixture set only: the package suite shares one
    // database across parallel files, so absolute report totals are flaky.
    const now = new Date();
    const inWindow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const beforeWindow = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const user = await userFactory.create();
    const installation = await githubInstallationFactory.create({
      installedByUserId: user.id,
    });
    const repository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: user.id,
      fullName: `acme/instance-report-prs-${user.id.slice(0, 8)}`,
      name: `instance-report-prs-${user.id.slice(0, 8)}`,
    });

    const standardTask = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'standard',
    });
    const reviewTask = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'pr_review',
    });
    const conflictTask = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'pr_conflict_resolve',
    });
    const secondAuthored = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'standard',
    });
    const draftTask = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'standard',
    });
    const closedTask = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'standard',
    });
    const mixedCaseTask = await taskFactory.create({
      initiatorUserId: user.id,
      workflow: 'standard',
    });

    await db.insert(taskPullRequests).values([
      {
        taskId: standardTask.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prNumber: 10,
        prUrl: `https://github.com/${repository.fullName}/pull/10`,
        prTitle: 'Merged fast',
        status: 'merged',
        detectedAt: inWindow,
        createdAt: inWindow,
        updatedAt: inWindow,
      },
      {
        taskId: secondAuthored.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prNumber: 11,
        prUrl: `https://github.com/${repository.fullName}/pull/11`,
        prTitle: 'Merged slower',
        status: 'merged',
        detectedAt: inWindow,
        createdAt: inWindow,
        updatedAt: inWindow,
      },
      {
        taskId: draftTask.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prNumber: 12,
        prUrl: `https://github.com/${repository.fullName}/pull/12`,
        prTitle: 'Still draft',
        status: 'draft',
        detectedAt: inWindow,
        createdAt: inWindow,
        updatedAt: inWindow,
      },
      {
        taskId: closedTask.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prNumber: 13,
        prUrl: `https://github.com/${repository.fullName}/pull/13`,
        prTitle: 'Closed',
        status: 'closed',
        detectedAt: inWindow,
        createdAt: inWindow,
        updatedAt: inWindow,
      },
      {
        taskId: reviewTask.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prNumber: 99,
        prUrl: `https://github.com/${repository.fullName}/pull/99`,
        prTitle: 'Reviewed only',
        status: 'merged',
        detectedAt: inWindow,
        createdAt: inWindow,
        updatedAt: inWindow,
      },
      {
        taskId: conflictTask.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prNumber: 100,
        prUrl: `https://github.com/${repository.fullName}/pull/100`,
        prTitle: 'Conflict only',
        status: 'open',
        detectedAt: inWindow,
        createdAt: inWindow,
        updatedAt: inWindow,
      },
      // Historical association with different casing than the in-window row.
      {
        taskId: mixedCaseTask.id,
        repositoryId: repository.id,
        repository: repository.fullName.toUpperCase(),
        prNumber: 10,
        prUrl: `https://github.com/${repository.fullName.toUpperCase()}/pull/10`,
        prTitle: 'Older mixed-case association',
        status: 'open',
        detectedAt: beforeWindow,
        createdAt: beforeWindow,
        updatedAt: beforeWindow,
      },
    ]);

    await db.insert(pullRequestFacts).values([
      {
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        sourceControlProvider: 'github',
        externalPullRequestId: 3_000_010 + (Date.now() % 1_000_000),
        prNumber: 10,
        title: 'Merged fast',
        htmlUrl: `https://github.com/${repository.fullName}/pull/10`,
        state: 'merged',
        createdAtRemote: new Date(inWindow.getTime() - 2 * 60 * 60 * 1000),
        updatedAtRemote: inWindow,
        closedAtRemote: inWindow,
        mergedAtRemote: inWindow,
      },
      {
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        sourceControlProvider: 'github',
        externalPullRequestId: 4_000_011 + (Date.now() % 1_000_000),
        prNumber: 11,
        title: 'Merged slower',
        htmlUrl: `https://github.com/${repository.fullName}/pull/11`,
        state: 'merged',
        createdAtRemote: new Date(inWindow.getTime() - 10 * 60 * 60 * 1000),
        updatedAtRemote: inWindow,
        closedAtRemote: inWindow,
        mergedAtRemote: inWindow,
      },
    ]);

    const productOpenedRows = await db
      .select({
        sourceControlProvider: taskPullRequests.sourceControlProvider,
        host: taskPullRequests.host,
        repository: taskPullRequests.repository,
        repositoryId: taskPullRequests.repositoryId,
        prNumber: taskPullRequests.prNumber,
        prUrl: taskPullRequests.prUrl,
        status: taskPullRequests.status,
        detectedAt: taskPullRequests.detectedAt,
        updatedAt: taskPullRequests.updatedAt,
      })
      .from(taskPullRequests)
      .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
      .where(
        and(
          eq(taskPullRequests.repositoryId, repository.id),
          notInArray(tasks.workflow, [...SOURCE_CONTROL_AUTOMATION_WORKFLOWS]),
        ),
      );

    expect(productOpenedRows.map((row) => row.prNumber).sort()).toEqual([
      10, 10, 11, 12, 13,
    ]);

    const deduped = dedupeAuthoredPullRequests(productOpenedRows);
    const factRows = await db
      .select({
        prNumber: pullRequestFacts.prNumber,
        createdAtRemote: pullRequestFacts.createdAtRemote,
        mergedAtRemote: pullRequestFacts.mergedAtRemote,
      })
      .from(pullRequestFacts)
      .where(
        and(
          eq(pullRequestFacts.repositoryId, repository.id),
          inArray(pullRequestFacts.prNumber, [10, 11]),
        ),
      );

    const mergeDurations = new Map<string, number>();
    for (const entry of deduped) {
      if (
        entry.prNumber == null ||
        bucketPullRequestStatus(entry.status) !== 'merged'
      ) {
        continue;
      }
      const fact = factRows.find((row) => row.prNumber === entry.prNumber);
      if (!fact?.mergedAtRemote) {
        continue;
      }
      mergeDurations.set(
        entry.key,
        Math.round(
          (fact.mergedAtRemote.getTime() - fact.createdAtRemote.getTime()) /
            1000,
        ),
      );
    }

    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cohort = summarizePullRequestCohort(deduped, since, mergeDurations);

    // PR #10 first-detected outside the window via mixed-case history row.
    expect(cohort).toEqual({
      opened: 3,
      open: 1,
      closed: 1,
      merged: 1,
      medianTimeToMergeSeconds: 10 * 60 * 60,
    });

    // Smoke: full collector still returns the new field shape under suite load.
    const report = await collectInstanceReportStats(now);
    expect(report.pullRequests7d).toEqual(
      expect.objectContaining({
        opened: expect.any(Number),
        open: expect.any(Number),
        closed: expect.any(Number),
        merged: expect.any(Number),
      }),
    );
    expect(
      report.pullRequests7d.open +
        report.pullRequests7d.closed +
        report.pullRequests7d.merged,
    ).toBe(report.pullRequests7d.opened);
  });
});
