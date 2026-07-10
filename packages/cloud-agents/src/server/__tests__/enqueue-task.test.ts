// pnpm --filter @roomote/cloud-agents test src/server/__tests__/enqueue-task.test.ts
//
// Real-database integration tests for the Stage 2 enqueue rewrite: initiator
// stamping, resume semantics, enqueue-time PR linkage, and pr_review queue
// scope dedup.
import Redis from 'ioredis-mock';

import {
  type TaskSpec,
  type SnapshotResumeTask,
  RunStatus,
  TaskPayloadKind,
} from '@roomote/types';
import {
  db,
  eq,
  inArray,
  tasks,
  taskRuns,
  taskPullRequests,
  taskRunEvents,
  users,
  environments,
  environmentRepositoryMappings,
  repositories,
  userFactory,
  environmentFactory,
  repositoryFactory,
} from '@roomote/db/server';

import {
  CloudJobQueue,
  enqueueTask,
  resolveQueueScope,
  type FreshCloudTaskLaunch,
} from '../cloud-job-queue';

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

const explicitWorkKind = {
  kind: 'implement',
  source: 'explicit_bootstrap',
  confidence: null,
} as const;

function standardTaskInput(
  overrides: Partial<Extract<TaskSpec, { type: 'standard' }>> = {},
): Extract<TaskSpec, { type: 'standard' }> {
  return {
    type: TaskPayloadKind.StandardTask,
    requestedWorkKindDecision: explicitWorkKind,
    payload: {
      repo: 'acme/widgets',
      description: 'Do the thing',
    },
    ...overrides,
  } as Extract<TaskSpec, { type: 'standard' }>;
}

async function createUser(): Promise<string> {
  const user = await userFactory.create();
  createdUserIds.push(user.id);
  return user.id;
}

async function launchFresh(
  input: Omit<FreshCloudTaskLaunch, 'task'> & {
    task?: FreshCloudTaskLaunch['task'];
  },
) {
  const run = await enqueueTask(
    {
      task: standardTaskInput(),
      ...input,
    } as FreshCloudTaskLaunch,
    { enqueue: false, skipEarlyTitleGeneration: true },
  );
  createdTaskIds.push(run.taskId);
  return run;
}

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db
      .delete(taskRunEvents)
      .where(inArray(taskRunEvents.taskId, createdTaskIds));
    await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    await db
      .delete(taskPullRequests)
      .where(inArray(taskPullRequests.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }

  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('enqueueTask initiator stamping', () => {
  it('persists a linked-user initiator with CHECK-valid shape', async () => {
    const userId = await createUser();

    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task).toBeDefined();
    expect(task!.initiatorKind).toBe('user');
    expect(task!.initiatorUserId).toBe(userId);
    expect(task!.initiatorAutomation).toBeNull();
    expect(task!.workflow).toBe('standard');
    expect(task!.surface).toBe('web');
    expect(task!.trigger).toBe('manual');
    expect(task!.visibility).toBe('visible');
    expect(task!.state).toBe('active');
    // Commit author evaluated unconditionally: linked user -> 'user'.
    expect(task!.commitAuthorKind).toBe('user');
    expect(task!.commitAuthorUserId).toBe(userId);

    expect(run.kind).toBe('fresh');
    expect(run.payloadKind).toBe('standard');
    expect(run.actingUserId).toBe(userId);
    expect(run.sourceRunId).toBeNull();
  });

  it('persists an unlinked external actor with actor context and external commit author', async () => {
    const run = await launchFresh({
      task: standardTaskInput({
        githubLogin: 'octofan',
        githubUserId: 987654,
      }),
      initiator: {
        kind: 'user',
        externalId: 'U12345',
        displayName: 'Octo Fan',
      },
      workflow: 'standard',
      surface: 'slack',
      trigger: 'message',
      channels: {
        slackChannelId: 'C42',
        slackThreadTs: '1234.5678',
      },
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task!.initiatorKind).toBe('user');
    expect(task!.initiatorUserId).toBeNull();
    expect(task!.initiatorAutomation).toBeNull();
    expect(task!.actorExternalId).toBe('U12345');
    expect(task!.actorDisplayName).toBe('Octo Fan');
    expect(task!.slackChannelId).toBe('C42');
    expect(task!.slackThreadTs).toBe('1234.5678');
    // Unlinked human with a GitHub identity -> 'external' with login + id.
    expect(task!.commitAuthorKind).toBe('external');
    expect(task!.commitAuthorLogin).toBe('octofan');
    expect(task!.commitAuthorExternalId).toBe('987654');
    expect(task!.prAssigneeLogin).toBe('octofan');

    expect(run.actingUserId).toBeNull();
  });

  it('persists an automation initiator with roomote commit author and null acting user', async () => {
    const run = await launchFresh({
      initiator: {
        kind: 'automation',
        key: 'suggester',
        actor: { externalId: 'gh-123', displayName: 'PR Author' },
      },
      workflow: 'scan',
      surface: 'system',
      trigger: 'schedule',
      visibility: 'hidden',
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task!.initiatorKind).toBe('automation');
    expect(task!.initiatorAutomation).toBe('suggester');
    expect(task!.initiatorUserId).toBeNull();
    expect(task!.actorExternalId).toBe('gh-123');
    expect(task!.actorDisplayName).toBe('PR Author');
    expect(task!.visibility).toBe('hidden');
    expect(task!.commitAuthorKind).toBe('roomote');
    expect(task!.commitAuthorUserId).toBeNull();
    expect(task!.prAssigneeLogin).toBeNull();

    expect(run.actingUserId).toBeNull();
  });

  it('promotes matchedUserId to initiatorUserId while keeping actor context', async () => {
    const userId = await createUser();

    const run = await launchFresh({
      initiator: {
        kind: 'user',
        externalId: 'U999',
        displayName: 'Matched Human',
        matchedUserId: userId,
      },
      workflow: 'standard',
      surface: 'slack',
      trigger: 'message',
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task!.initiatorKind).toBe('user');
    expect(task!.initiatorUserId).toBe(userId);
    expect(task!.actorExternalId).toBe('U999');
    expect(task!.actorDisplayName).toBe('Matched Human');
    expect(run.actingUserId).toBe(userId);
  });
});

describe('enqueueTask snapshot resume', () => {
  it('attaches a resume run to the source task without re-attribution', async () => {
    const initiatorUserId = await createUser();
    const resumerUserId = await createUser();

    const freshRun = await launchFresh({
      initiator: { kind: 'user', userId: initiatorUserId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const taskBefore = await db.query.tasks.findFirst({
      where: eq(tasks.id, freshRun.taskId),
    });

    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-123',
        sourceCloudJobId: freshRun.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      {
        task: resumeTask,
        actingUserId: resumerUserId,
      },
      { enqueue: false },
    );

    expect(resumeRun.taskId).toBe(freshRun.taskId);
    expect(resumeRun.kind).toBe('resume');
    expect(resumeRun.sourceRunId).toBe(freshRun.id);
    expect(resumeRun.payloadKind).toBe('snapshot_resume');
    expect(resumeRun.actingUserId).toBe(resumerUserId);
    expect(resumeRun.sourceSnapshotId).toBe('snap-123');

    // No task mutation, no attribution recomputation: the initiator stamp
    // and commit-author block are byte-identical to the fresh launch.
    const taskAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, freshRun.taskId),
    });

    expect(taskAfter).toEqual(taskBefore);
    expect(taskAfter!.initiatorUserId).toBe(initiatorUserId);

    const runsForTask = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, freshRun.taskId),
    });
    expect(runsForTask).toHaveLength(2);
  });

  it('rejects a resume without a source run id', async () => {
    const resumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-void',
      },
    } as SnapshotResumeTask;

    await expect(
      enqueueTask({ task: resumeTask }, { enqueue: false }),
    ).rejects.toThrow('source run id');
  });
});

describe('enqueueTask PR linkage', () => {
  it('inserts the task_pull_requests row inside the create transaction', async () => {
    const prTask = {
      type: TaskPayloadKind.GithubPrReview,
      requestedWorkKindDecision: explicitWorkKind,
      payload: {
        repo: 'acme/widgets',
        prNumber: 77,
        prTitle: 'Add widgets',
        prUrl: 'https://github.com/acme/widgets/pull/77',
        headSha: 'a'.repeat(40),
      },
    } as Extract<TaskSpec, { type: 'github_pr_review' }>;

    const run = await launchFresh({
      task: prTask,
      initiator: {
        kind: 'automation',
        key: 'review_code',
        actor: { externalId: '4242', displayName: 'octocat' },
      },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: {
        provider: 'github',
        repository: 'acme/widgets',
        prNumber: 77,
        prUrl: 'https://github.com/acme/widgets/pull/77',
        prTitle: 'Add widgets',
        prSha: 'a'.repeat(40),
        prBaseRef: 'main',
        prBaseSha: 'b'.repeat(40),
      },
    });

    const prRows = await db.query.taskPullRequests.findMany({
      where: eq(taskPullRequests.taskId, run.taskId),
    });

    expect(prRows).toHaveLength(1);
    expect(prRows[0]!.sourceControlProvider).toBe('github');
    expect(prRows[0]!.repository).toBe('acme/widgets');
    expect(prRows[0]!.prNumber).toBe(77);
    expect(prRows[0]!.prUrl).toBe('https://github.com/acme/widgets/pull/77');
    expect(prRows[0]!.prSha).toBe('a'.repeat(40));
    expect(prRows[0]!.prBaseRef).toBe('main');
    expect(prRows[0]!.prBaseSha).toBe('b'.repeat(40));
  });

  it('rejects pr_review launches without prLinkage', async () => {
    const prTask = {
      type: TaskPayloadKind.GithubPrReview,
      requestedWorkKindDecision: explicitWorkKind,
      payload: {
        repo: 'acme/widgets',
        prNumber: 78,
        prTitle: 'Add more widgets',
        prUrl: 'https://github.com/acme/widgets/pull/78',
        headSha: 'c'.repeat(40),
      },
    } as Extract<TaskSpec, { type: 'github_pr_review' }>;

    await expect(
      enqueueTask(
        {
          task: prTask,
          initiator: { kind: 'automation', key: 'review_code' },
          workflow: 'pr_review',
          surface: 'github',
          trigger: 'webhook',
        },
        { enqueue: false },
      ),
    ).rejects.toThrow('prLinkage');
  });
});

describe('enqueue-failure cancel task state', () => {
  // A run canceled before it is queued must leave the owning task in a
  // terminal state. finishRun never runs for these runs, so
  // cancelCloudJobBeforeQueue is responsible for the tasks.state write.
  // Regression guard for tasks stranded in 'active' with a canceled run.
  it('marks the task canceled when the run is canceled before it is queued', async () => {
    const userId = await createUser();

    let capturedTaskId: string | undefined;

    await expect(
      enqueueTask(
        {
          task: standardTaskInput(),
          initiator: { kind: 'user', userId },
          workflow: 'standard',
          surface: 'web',
          trigger: 'manual',
        },
        {
          skipEarlyTitleGeneration: true,
          // Throwing before the queue push exercises the enqueue-failure
          // cancel path (cancelCloudJobBeforeQueue) after the task and its
          // first run have been persisted.
          beforeEnqueue: async (cloudJob) => {
            capturedTaskId = cloudJob.taskId;
            throw new Error('boom before enqueue');
          },
        },
      ),
    ).rejects.toThrow('boom before enqueue');

    expect(capturedTaskId).toBeDefined();
    createdTaskIds.push(capturedTaskId!);

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, capturedTaskId!),
    });
    const runs = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, capturedTaskId!),
    });

    expect(task!.state).toBe('canceled');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe(RunStatus.Canceled);
    expect(runs[0]!.canceledAt).not.toBeNull();
  });
});

describe('enqueueTask source-control provider stamping', () => {
  const createdEnvironmentIds: string[] = [];
  const createdRepositoryIds: string[] = [];

  afterAll(async () => {
    // Mappings cascade-delete with their environment/repository.
    if (createdEnvironmentIds.length > 0) {
      await db
        .delete(environments)
        .where(inArray(environments.id, createdEnvironmentIds));
    }
    if (createdRepositoryIds.length > 0) {
      await db
        .delete(repositories)
        .where(inArray(repositories.id, createdRepositoryIds));
    }
  });

  it('stamps gitlab on an environment-workspace launch for a gitlab-only deployment', async () => {
    const userId = await createUser();
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: userId,
      fullName: 'group/project',
      isActive: true,
    });
    createdRepositoryIds.push(repository.id);

    const environment = await environmentFactory.create({
      createdByUserId: userId,
    });
    createdEnvironmentIds.push(environment.id);

    await db.insert(environmentRepositoryMappings).values({
      environmentId: environment.id,
      repositoryId: repository.id,
    });

    const run = await launchFresh({
      task: standardTaskInput({
        payload: {
          // environmentId makes this an environment workspace regardless of
          // repo, so the provider must resolve via the environment-repository
          // mapping (this repo is intentionally not in the repositories table).
          repo: 'unmapped/repo',
          environmentId: environment.id,
          description: 'Work in the gitlab environment',
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const persistedRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });

    expect(
      (persistedRun!.payload as { sourceControlProvider?: string })
        .sourceControlProvider,
    ).toBe('gitlab');
  });
});

describe('pr_review queue scope dedup', () => {
  let previousQueue: CloudJobQueue | null;
  let queueRedis: InstanceType<typeof Redis>;

  beforeEach(() => {
    previousQueue = CloudJobQueue.queue;
    queueRedis = new Redis();
    CloudJobQueue.queue = new CloudJobQueue({ redis: queueRedis, timeout: 1 });
  });

  afterEach(async () => {
    CloudJobQueue.queue = previousQueue;
    await queueRedis.flushall();
    queueRedis.disconnect();
  });

  const prLinkage = {
    provider: 'github' as const,
    repository: 'acme/widgets',
    prNumber: 42,
    prUrl: 'https://github.com/acme/widgets/pull/42',
  };

  it('computes a stable repo:prNumber scope for pr_review launches', () => {
    const first = resolveQueueScope({
      workflow: 'pr_review',
      payloadKind: TaskPayloadKind.GithubPrReview,
      prLinkage,
    });
    const second = resolveQueueScope({
      workflow: 'pr_review',
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      prLinkage,
    });

    expect(first).toBe('acme/widgets:42');
    expect(second).toBe('acme/widgets:42');
  });

  it('gives non-pr-review launches unique scopes', () => {
    const one = resolveQueueScope({
      workflow: 'standard',
      payloadKind: TaskPayloadKind.StandardTask,
    });
    const two = resolveQueueScope({
      workflow: 'standard',
      payloadKind: TaskPayloadKind.StandardTask,
    });
    const conflict = resolveQueueScope({
      workflow: 'pr_conflict_resolve',
      payloadKind: TaskPayloadKind.GithubPrConflictResolve,
      prLinkage,
    });

    expect(one).not.toBe(two);
    expect(conflict).not.toBe('acme/widgets:42');
  });

  it('supersedes an older queued entry with the same pr_review scope', async () => {
    const redis = new Redis();
    const queue = new CloudJobQueue({ redis, timeout: 1 });
    const scope = resolveQueueScope({
      workflow: 'pr_review',
      payloadKind: TaskPayloadKind.GithubPrReview,
      prLinkage,
    });

    await queue.enqueue({ id: 900001, scope });
    await queue.enqueue({ id: 900002, scope });

    const dequeued = await queue.dequeue(false);
    expect(dequeued?.id).toBe(900002);

    const empty = await queue.dequeue(false);
    expect(empty).toBeNull();

    await redis.flushall();
  });

  it('persists the scope and transactionally cancels the evicted run', async () => {
    const uniquePrNumber = 424_242;
    const scope = `acme/queue-atomic:${uniquePrNumber}`;
    const linkage = {
      provider: 'github' as const,
      repository: 'acme/queue-atomic',
      prNumber: uniquePrNumber,
      prUrl: `https://github.com/acme/queue-atomic/pull/${uniquePrNumber}`,
    };
    const makeInput = (headSha: string): FreshCloudTaskLaunch => ({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: linkage.repository,
          prNumber: linkage.prNumber,
          prTitle: 'Atomic queue review',
          prUrl: linkage.prUrl,
          headSha,
        },
      },
      initiator: { kind: 'automation', key: 'review_code' },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: linkage,
    });

    const older = await enqueueTask(makeInput('a'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    createdTaskIds.push(older.taskId);

    const newer = await enqueueTask(makeInput('b'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    createdTaskIds.push(newer.taskId);

    const persistedRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.id, [older.id, newer.id]),
    });
    const persistedOlder = persistedRuns.find((run) => run.id === older.id);
    const persistedNewer = persistedRuns.find((run) => run.id === newer.id);

    expect(persistedOlder?.queueScope).toBe(scope);
    expect(persistedOlder?.status).toBe(RunStatus.Canceled);
    expect(persistedOlder?.canceledAt).not.toBeNull();
    expect(persistedNewer?.queueScope).toBe(scope);
    expect(persistedNewer?.status).toBe(RunStatus.Pending);

    const queued = await CloudJobQueue.getInstance().dequeue(false);
    expect(queued).toEqual({ id: newer.id, scope });
    await CloudJobQueue.getInstance().releaseLock(scope, newer.id);
  });
});
