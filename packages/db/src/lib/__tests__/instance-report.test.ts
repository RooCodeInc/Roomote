import { and, eq, inArray, notInArray } from 'drizzle-orm';

import {
  RunStatus,
  SOURCE_CONTROL_AUTOMATION_WORKFLOWS,
  TaskPayloadKind,
} from '@roomote/types';

import {
  db,
  githubInstallationFactory,
  llmUsageEvents,
  pullRequestFacts,
  repositoryFactory,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  taskPullRequests,
  taskRuns,
  tasks,
  userFactory,
} from '../../server';
import {
  bucketPullRequestStatus,
  collectConfiguredInferenceProviders,
  collectConfiguredRuntimeEnvVarNames,
  collectInstanceReportStats,
  dedupeAuthoredPullRequests,
  median,
  summarizeAutomations,
  summarizePullRequestCohort,
} from '../instance-report';

describe('instance-report pure helpers', () => {
  it('reports configured inference providers without reading secret values', () => {
    expect(
      collectConfiguredInferenceProviders({
        persistedEnvVarNames: ['ANTHROPIC_API_KEY'],
        runtimeEnvVarNames: ['OPENAI_API_KEY'],
        chatgptConnected: true,
        githubCopilotConnected: false,
        xaiSubscriptionConnected: true,
      }),
    ).toEqual(['anthropic', 'chatgpt', 'openai', 'xai', 'xai-subscription']);
  });

  it('only includes runtime configuration names with non-blank values', () => {
    expect(
      collectConfiguredRuntimeEnvVarNames({
        ANTHROPIC_API_KEY: 'secret-value',
        OPENAI_API_KEY: ' ',
      }),
    ).toEqual(['ANTHROPIC_API_KEY']);
  });

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

  it('summarizes automation totals from dynamic built-in rows', () => {
    expect(
      summarizeAutomations({
        customTotal: 4,
        customEnabled: 2,
        builtInRows: [
          { key: 'review_code', enabled: true },
          { key: 'future_automation', enabled: true },
          { key: 'disabled_automation', enabled: false },
        ],
      }),
    ).toEqual({
      custom: {
        total: 4,
        enabled: 2,
      },
      builtIn: {
        enabled: 2,
        enabledByKey: {
          review_code: true,
          future_automation: true,
        },
      },
    });
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
    expect(report.providers.computeConfigured).toContain('docker');
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

describe('collectInstanceReportStats task usage isolation', () => {
  it('excludes environment snapshots from task usage aggregates', async () => {
    // The report window is [now - 24h, ∞) with no upper bound, and other test
    // files write/delete rows in the shared database concurrently (some with
    // timestamps as late as 2099). Pick a `now` whose window no other suite's
    // timestamps can reach so the aggregates below cover exactly the rows this
    // test creates, letting us assert exact values instead of racy baseline
    // deltas.
    const now = new Date('2200-01-01T00:00:00.000Z');
    const suffix = Date.now().toString();
    const productModel = `product-model-${suffix}`;
    const snapshotModel = `snapshot-model-${suffix}`;
    const privateOwner = await userFactory.create();
    const productTask = await taskFactory.create({
      workflow: 'standard',
      model: productModel,
      privacy: 'private',
      privateOwnerUserId: privateOwner.id,
      createdAt: now,
    });
    const snapshotTask = await taskFactory.create({
      workflow: 'env_snapshot',
      model: snapshotModel,
      privacy: 'private',
      privateOwnerUserId: privateOwner.id,
      createdAt: now,
    });

    await db.insert(taskRuns).values({
      taskId: productTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
      kind: 'fresh',
      status: RunStatus.Completed,
      completedAt: now,
      payload: { repo: 'acme/product', description: 'Product task' },
    });
    await db.insert(taskRuns).values({
      taskId: snapshotTask.id,
      payloadKind: TaskPayloadKind.SnapshotEnvironment,
      kind: 'fresh',
      status: RunStatus.Completed,
      completedAt: now,
      payload: {
        repo: '',
        environmentId: crypto.randomUUID(),
      },
    });

    await db.insert(llmUsageEvents).values([
      {
        eventKey: `product-usage-${suffix}`,
        taskId: productTask.id,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        costMicroUsd: 40,
        costSource: 'opencode_message',
        createdAt: now,
      },
      {
        eventKey: `snapshot-usage-${suffix}`,
        taskId: snapshotTask.id,
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        costMicroUsd: 400,
        costSource: 'opencode_message',
        createdAt: now,
      },
    ]);

    const report = await collectInstanceReportStats(now);

    expect(report.tasks24h.created).toBe(1);
    expect(report.tasks24h.completed).toBe(1);
    expect(report.tasks24h.byHarness).toEqual({ 'opencode-server': 1 });
    expect(report.tasks24h.byModel).toEqual([
      {
        provider: 'openai',
        model: productModel,
        count: 1,
      },
    ]);
    expect(report.tasks24h.byModel).not.toContainEqual(
      expect.objectContaining({ model: snapshotModel }),
    );
    expect(report.tasks24h.tokens).toEqual({
      input: 10,
      output: 20,
      total: 30,
      costMicroUsd: 40,
    });
  });
});

describe('collectInstanceReportStats session usage', () => {
  it('returns empty session aggregates when the window has no data', async () => {
    const report = await collectInstanceReportStats(
      new Date('2400-01-01T00:00:00.000Z'),
    );

    expect(report.sessions24h).toEqual({
      created: 0,
      bySourceSurface: {},
      bySourceTrigger: {},
      byOwnerKind: {},
      tokens: {
        input: 0,
        output: 0,
        total: 0,
        costMicroUsd: 0,
      },
    });
  });

  it('counts sessions and attributed usage with task-equivalent window semantics', async () => {
    const now = new Date('2500-01-02T00:00:00.000Z');
    const since = new Date('2500-01-01T00:00:00.000Z');
    const beforeSince = new Date(since.getTime() - 1);
    const afterNow = new Date(now.getTime() + 1);
    const suffix = Date.now().toString();

    const boundarySession = await sessionFactory.create({
      ownerKind: 'user',
      sourceSurface: 'web',
      sourceTrigger: 'manual',
    });
    const recentSession = await sessionFactory.create({
      ownerKind: 'automation',
      sourceSurface: 'slack',
      sourceTrigger: 'schedule',
    });
    const oldSession = await sessionFactory.create({
      ownerKind: 'system',
      sourceSurface: 'system',
      sourceTrigger: 'manual',
    });
    await Promise.all([
      db
        .update(sessions)
        .set({ createdAt: since })
        .where(eq(sessions.id, boundarySession.id)),
      db
        .update(sessions)
        .set({ createdAt: afterNow })
        .where(eq(sessions.id, recentSession.id)),
      db
        .update(sessions)
        .set({ createdAt: beforeSince })
        .where(eq(sessions.id, oldSession.id)),
    ]);

    const directTask = await taskFactory.create({
      workflow: 'standard',
      createdAt: now,
    });
    const delegatedTask = await taskFactory.create({
      workflow: 'standard',
      createdAt: now,
    });
    const snapshotTask = await taskFactory.create({
      workflow: 'env_snapshot',
      createdAt: now,
    });
    await db.insert(sessionTasks).values([
      {
        sessionId: boundarySession.id,
        taskId: directTask.id,
        origin: 'direct_launch',
      },
      {
        sessionId: boundarySession.id,
        taskId: delegatedTask.id,
        origin: 'fast_delegation',
      },
      {
        sessionId: boundarySession.id,
        taskId: snapshotTask.id,
        origin: 'follow_up',
      },
    ]);

    await db.insert(llmUsageEvents).values([
      {
        eventKey: `session-direct-${suffix}`,
        taskId: directTask.id,
        sessionId: boundarySession.id,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        costMicroUsd: 40,
        costSource: 'opencode_message',
        createdAt: since,
      },
      {
        eventKey: `session-delegated-${suffix}`,
        taskId: delegatedTask.id,
        sessionId: boundarySession.id,
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        costMicroUsd: 4,
        costSource: 'opencode_message',
        createdAt: now,
      },
      {
        eventKey: `session-snapshot-${suffix}`,
        taskId: snapshotTask.id,
        sessionId: boundarySession.id,
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        costMicroUsd: 400,
        costSource: 'opencode_message',
        createdAt: now,
      },
      {
        eventKey: `session-fast-${suffix}`,
        sessionId: recentSession.id,
        inputTokens: 5,
        outputTokens: 6,
        totalTokens: 11,
        costMicroUsd: 12,
        costSource: 'opencode_message',
        createdAt: afterNow,
      },
      {
        eventKey: `session-unattributed-${suffix}`,
        inputTokens: 1_000,
        outputTokens: 2_000,
        totalTokens: 3_000,
        costMicroUsd: 4_000,
        costSource: 'opencode_message',
        createdAt: now,
      },
      {
        eventKey: `session-before-window-${suffix}`,
        sessionId: recentSession.id,
        inputTokens: 10_000,
        outputTokens: 20_000,
        totalTokens: 30_000,
        costMicroUsd: 40_000,
        costSource: 'opencode_message',
        createdAt: beforeSince,
      },
    ]);

    const report = await collectInstanceReportStats(now);

    expect(report.sessions24h).toEqual({
      created: 2,
      bySourceSurface: { slack: 1, web: 1 },
      bySourceTrigger: { manual: 1, schedule: 1 },
      byOwnerKind: { automation: 1, user: 1 },
      tokens: {
        input: 16,
        output: 28,
        total: 44,
        costMicroUsd: 56,
      },
    });
  });
});
