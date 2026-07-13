import {
  db,
  githubInstallationFactory,
  pullRequestFacts,
  repositoryFactory,
  taskFactory,
  taskPullRequests,
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
          key: 'github:acme/app#1',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 1,
          status: 'open',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:acme/app#2',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 2,
          status: 'draft',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:acme/app#3',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 3,
          status: 'closed',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:acme/app#4',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 4,
          status: 'merged',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:acme/app#5',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 5,
          status: 'merged',
          firstDetectedAt: inWindow,
        },
        {
          key: 'github:acme/app#old',
          repository: 'acme/app',
          repositoryId: 'r1',
          prNumber: 99,
          status: 'merged',
          firstDetectedAt: beforeWindow,
        },
      ],
      since,
      new Map([
        ['github:acme/app#4', 100],
        ['github:acme/app#5', 300],
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
});

describe('collectInstanceReportStats pullRequests7d', () => {
  it('counts product-authored PRs and median TTM from local facts without reviews', async () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    const inWindow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const user = await userFactory.create();
    const installation = await githubInstallationFactory.create({
      installedByUserId: user.id,
    });
    const repository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: user.id,
      fullName: 'acme/instance-report-prs',
      name: 'instance-report-prs',
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
    ]);

    await db.insert(pullRequestFacts).values([
      {
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        sourceControlProvider: 'github',
        externalPullRequestId: 1_000_010,
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
        externalPullRequestId: 1_000_011,
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

    const stats = await collectInstanceReportStats(now);

    expect(stats.pullRequests7d).toEqual({
      opened: 4,
      open: 1,
      closed: 1,
      merged: 2,
      // median of 2h and 10h = 6h = 21600s
      medianTimeToMergeSeconds: 6 * 60 * 60,
    });
  });
});
