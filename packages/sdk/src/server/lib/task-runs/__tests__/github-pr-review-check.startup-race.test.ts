const mocks = vi.hoisted(() => ({
  createCheck: vi.fn(),
  getTokenCheck: vi.fn(),
  updateCheck: vi.fn(),
  contended: vi.fn(),
}));

vi.mock('@roomote/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/github')>()),
  getInstallationOctokit: vi.fn().mockResolvedValue({
    rest: { checks: { create: mocks.createCheck, update: mocks.updateCheck } },
  }),
  getCheckRun: mocks.getTokenCheck,
  updateCheckRun: (_token: string, input: unknown) => mocks.updateCheck(input),
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    acquireRedisLock: async (
      ...args: Parameters<typeof actual.acquireRedisLock>
    ) => {
      const lock = await actual.acquireRedisLock(...args);
      if (!lock) mocks.contended();
      return lock;
    },
  };
});

import {
  db,
  eq,
  inArray,
  runFactory,
  taskFactory,
  taskPullRequests,
  tasks,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import {
  acquireGithubPrReviewLifecycleLock,
  markGithubPrReviewCheckInProgress,
  publishGithubPrReviewCheck,
} from '../github-pr-review-check';

const repository = 'review-check-startup-race/repo';
const taskIds: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Race barrier timed out')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('startup and replacement with real DB/Redis serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    if (taskIds.length)
      await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
  });

  it.each(['startup', 'publisher'] as const)(
    'keeps the superseded check cancelled when %s acquires the lock first',
    async (first) => {
      const task = await taskFactory.create();
      taskIds.push(task.id);
      const run = await runFactory.create({
        taskId: task.id,
        status: RunStatus.Running,
        startedAt: new Date(),
      });
      await db.insert(taskPullRequests).values({
        taskId: task.id,
        repository,
        prNumber: 42,
        prUrl: `https://github.com/${repository}/pull/42`,
        sourceControlProvider: 'github',
        prSha: 'a'.repeat(40),
        githubCheckRunId: 10,
      });

      // Model GitHub state and retain immutable GET snapshots. Both commits'
      // checks belong to the same run, so the run-ID guard alone cannot help.
      const checks = new Map([
        [
          10,
          {
            status: 'queued',
            head_sha: 'a'.repeat(40),
            external_id: `roomote-review:${run.id}`,
          },
        ],
      ]);
      const paused = deferred();
      const resume = deferred();
      const contention = deferred();
      mocks.contended.mockImplementation(contention.resolve);
      mocks.getTokenCheck.mockImplementation(
        async (_token: string, input: { check_run_id: number }) => {
          const data = { ...checks.get(input.check_run_id)! };
          if (first === 'startup') {
            paused.resolve();
            await resume.promise;
          }
          return { data };
        },
      );
      mocks.createCheck.mockImplementation(async () => {
        if (first === 'publisher') {
          paused.resolve();
          await resume.promise;
        }
        checks.set(20, {
          status: 'queued',
          head_sha: 'b'.repeat(40),
          external_id: `roomote-review:${run.id}`,
        });
        return { data: { id: 20 } };
      });
      mocks.updateCheck.mockImplementation(
        async (input: { check_run_id: number; status: string }) => {
          checks.get(input.check_run_id)!.status = input.status;
        },
      );

      const startup = () =>
        markGithubPrReviewCheckInProgress({
          taskId: task.id,
          runId: run.id,
          gitHubToken: 'test-token',
        });
      const replace = async () => {
        // Production publishers are called under this non-reentrant lock.
        const release = await acquireGithubPrReviewLifecycleLock(
          repository,
          42,
        );
        if (!release) throw new Error('Could not acquire publication lock');
        try {
          await db
            .update(taskPullRequests)
            .set({ prSha: 'b'.repeat(40) })
            .where(eq(taskPullRequests.taskId, task.id));
          await publishGithubPrReviewCheck({
            installationId: 1,
            repository,
            prNumber: 42,
            headSha: 'b'.repeat(40),
            taskId: task.id,
            runId: run.id,
            signal: release.signal,
          });
        } finally {
          await release();
        }
      };

      const firstOperation = first === 'startup' ? startup() : replace();
      let secondOperation: Promise<void> | undefined;
      try {
        await bounded(paused.promise);
        secondOperation = first === 'startup' ? replace() : startup();
        // The second operation must contend rather than finish before the
        // first releases its provider read/create barrier.
        const outcome = await bounded(
          Promise.race([
            contention.promise.then(() => 'contended'),
            secondOperation.then(() => 'finished'),
          ]),
        );
        expect(outcome).toBe('contended');
        if (first === 'startup')
          expect(mocks.createCheck).not.toHaveBeenCalled();
        else expect(mocks.getTokenCheck).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await bounded(Promise.all([firstOperation, secondOperation]));
      }

      expect(checks.get(10)?.status).toBe('completed');
      expect(checks.get(20)?.status).toBe('in_progress');
      const updates = mocks.updateCheck.mock.calls.map(([input]) => ({
        id: input.check_run_id,
        status: input.status,
        conclusion: input.conclusion,
      }));
      const cancellation = updates.findIndex(
        (update) => update.id === 10 && update.conclusion === 'cancelled',
      );
      expect(cancellation).toBeGreaterThanOrEqual(0);
      expect(
        updates.slice(cancellation + 1).some((update) => update.id === 10),
      ).toBe(false);
      expect(mocks.getTokenCheck).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          check_run_id: first === 'startup' ? 10 : 20,
        }),
      );
      expect(
        await db.query.taskPullRequests.findFirst({
          where: eq(taskPullRequests.taskId, task.id),
        }),
      ).toMatchObject({ githubCheckRunId: 20 });
    },
    15_000,
  );
});
