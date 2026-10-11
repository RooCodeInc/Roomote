const mocks = vi.hoisted(() => ({
  getCheck: vi.fn(),
  getComment: vi.fn(),
  updateCheck: vi.fn(),
  enqueue: vi.fn().mockResolvedValue({ notifiedTaskCount: 1 }),
}));

vi.mock('@roomote/sdk/server', async () => ({
  completeGithubPrReviewCheckFromSummary: (
    await vi.importActual<typeof import('@roomote/sdk/server')>(
      '@roomote/sdk/server',
    )
  ).completeGithubPrReviewCheckFromSummary,
  enqueuePrReviewNotification: mocks.enqueue,
  markRoomotePullRequestReadyAfterCleanReview: vi
    .fn()
    .mockResolvedValue('review_not_clean'),
  startPrReviewNotificationCycle: vi.fn(),
}));

vi.mock('@roomote/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/github')>()),
  getInstallationOctokit: vi.fn().mockResolvedValue({
    rest: {
      checks: { get: mocks.getCheck, update: mocks.updateCheck },
      issues: { getComment: mocks.getComment },
    },
  }),
}));

// Deliberately no Redis or database mocks: contention and all ownership rows
// exercise the production lifecycle lock and Postgres queries.
import {
  db,
  eq,
  inArray,
  runFactory,
  taskFactory,
  taskPullRequests,
  tasks,
} from '@roomote/db/server';
import { setConfiguredGitHubAppSlugCache } from '@roomote/github';
import { acquireRedisLock, getRedis } from '@roomote/redis';
import { RunStatus } from '@roomote/types';
import { queuePrReviewSummaryNotification } from '../notifyPrReviewActivity';

const head = '1234567890abcdef1234567890abcdef12345678';
// Separate from the ordinary suite's repository so real locks/rows cannot clash.
const repository = 'review-owner-race/repo';
const commentId = 987654321;
const checkId = 987654322;
const startedAt = new Date('2026-10-10T12:00:00Z');
const updatedAt = '2026-10-10T12:02:00Z';
const taskIds: string[] = [];
type Format = 'session' | 'legacy';

function body(
  format: Format,
  taskId: string,
  findings = false,
  reviewing = false,
) {
  const link =
    format === 'legacy'
      ? `task/${taskId}`
      : 'sessions/11111111-1111-4111-8111-111111111111';
  return [
    `<!-- roomote-review-summary sha=${head} mode=initial version=3 phase=${reviewing ? 'reviewing' : 'reviewed'}${reviewing ? '' : ` outcome=${findings ? 'findings_remain' : 'clean'} finding_count=${findings ? 1 : 0}`} -->`,
    '<!-- roomote-review-status:start -->',
    `${reviewing ? 'Reviewing the PR now.' : findings ? '1 issue outstanding.' : 'No code issues found.'} [See review](https://roomote.test/${link})`,
    '<!-- roomote-review-status:end -->',
    '<!-- roomote-review-checklist:start -->',
    findings ? '- [ ] An unresolved finding.' : '',
    '<!-- roomote-review-checklist:end -->',
  ].join('\n');
}

function payload(terminalBody: string, previousBody: string) {
  return {
    action: 'edited',
    installation: { id: 1 },
    repository: { full_name: repository },
    issue: {
      number: 42,
      html_url: `https://github.com/${repository}/pull/42`,
      pull_request: { html_url: `https://github.com/${repository}/pull/42` },
    },
    comment: {
      id: commentId,
      body: terminalBody,
      user: { login: 'roomote[bot]' },
      created_at: startedAt.toISOString(),
      updated_at: updatedAt,
    },
    changes: { body: { from: previousBody } },
  } as Parameters<typeof queuePrReviewSummaryNotification>[0];
}

async function fixture(offset = 0) {
  const task = await taskFactory.create();
  taskIds.push(task.id);
  const run = await runFactory.create({
    taskId: task.id,
    status: RunStatus.Completed,
    startedAt: new Date(startedAt.getTime() + offset * 60_000),
  });
  await db.insert(taskPullRequests).values({
    taskId: task.id,
    repository,
    prNumber: 42,
    sourceControlProvider: 'github',
    prUrl: `https://github.com/${repository}/pull/42`,
    githubReviewCommentId: commentId,
    githubCheckRunId: checkId + offset,
  });
  return { task, run, checkId: checkId + offset };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Race barrier timed out')),
          12_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('canonical owner revalidation under real Redis contention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue({ notifiedTaskCount: 1 });
    mocks.updateCheck.mockResolvedValue(undefined);
    setConfiguredGitHubAppSlugCache({
      value: 'roomote',
      expiresAt: Date.now() + 60_000,
    });
  });
  afterEach(async () => {
    if (taskIds.length)
      await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
    setConfiguredGitHubAppSlugCache(null);
  });

  it.each(['session', 'legacy'] as const)(
    'refuses a retired owner after the real lock wait: %s',
    async (format) => {
      const old = await fixture();
      const release = await acquireRedisLock(
        `pr-review-synchronize:${repository}:42`,
        { ttlSeconds: 30 },
      );
      expect(release).toBeTruthy();
      const selected = deferred();
      mocks.enqueue.mockImplementationOnce(async () => {
        selected.resolve();
        return { notifiedTaskCount: 1 };
      });
      mocks.getCheck.mockResolvedValue({
        data: {
          head_sha: head,
          external_id: `roomote-review:${old.run.id}`,
          status: 'in_progress',
        },
      });
      let pending: Promise<void> | undefined;
      let replacement: Awaited<ReturnType<typeof fixture>> | undefined;
      try {
        pending = queuePrReviewSummaryNotification(
          payload(
            body(format, old.task.id, true),
            body(format, old.task.id, false, true),
          ),
        );
        await bounded(selected.promise);
        // Let the real reconciler attempt the held lock, not just the enqueue mock.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(
          await getRedis().exists(`pr-review-synchronize:${repository}:42`),
        ).toBe(1);
        expect(mocks.getCheck).not.toHaveBeenCalled();
        await db
          .update(tasks)
          .set({ deletedAt: new Date() })
          .where(eq(tasks.id, old.task.id));
        replacement = await fixture(1);
        mocks.getCheck.mockImplementation(
          async (input: { check_run_id: number }) => ({
            data: {
              head_sha: head,
              external_id: `roomote-review:${input.check_run_id === old.checkId ? old.run.id : replacement!.run.id}`,
              status: 'in_progress',
            },
          }),
        );
        mocks.getComment.mockResolvedValue({
          data: {
            body: body(format, replacement.task.id),
            updated_at: updatedAt,
          },
        });
      } finally {
        await release?.();
        if (pending) await bounded(pending);
      }
      console.log(
        'RACE_OBSERVATION',
        JSON.stringify({
          format,
          oldTask: old.task.id,
          oldRun: old.run.id,
          replacementTask: replacement?.task.id,
          replacementRun: replacement?.run.id,
          oldCheck: old.checkId,
          replacementCheck: replacement?.checkId,
          webhookOutcome: 'findings_remain',
          liveReplacementOutcome: 'clean',
          updates: mocks.updateCheck.mock.calls.map(([input]) => ({
            check: input.check_run_id,
            conclusion: input.conclusion,
          })),
        }),
      );
      // Neither the old nor replacement check belongs to this stale callback.
      expect(mocks.updateCheck).not.toHaveBeenCalled();
    },
    20_000,
  );

  it.each(['session', 'legacy'] as const)(
    'refuses deletion during the awaited live-comment read: %s',
    async (format) => {
      const old = await fixture();
      mocks.getCheck.mockResolvedValue({
        data: {
          head_sha: head,
          external_id: `roomote-review:${old.run.id}`,
          status: 'in_progress',
        },
      });
      mocks.getComment.mockImplementationOnce(async () => {
        await db
          .update(tasks)
          .set({ deletedAt: new Date() })
          .where(eq(tasks.id, old.task.id));
        const replacement = await fixture(1);
        return {
          data: {
            body: body(format, replacement.task.id),
            updated_at: updatedAt,
          },
        };
      });
      await queuePrReviewSummaryNotification(
        payload(
          body(format, old.task.id, true),
          body(format, old.task.id, false, true),
        ),
      );
      expect(mocks.updateCheck).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'legacy'] as const)(
    'refuses two live canonical owners: %s',
    async (format) => {
      const old = await fixture();
      await fixture(1);
      mocks.getCheck.mockResolvedValue({
        data: {
          head_sha: head,
          external_id: `roomote-review:${old.run.id}`,
          status: 'in_progress',
        },
      });
      mocks.getComment.mockResolvedValue({
        data: { body: body(format, old.task.id), updated_at: updatedAt },
      });
      await queuePrReviewSummaryNotification(
        payload(
          body(format, old.task.id),
          body(format, old.task.id, false, true),
        ),
      );
      expect(mocks.updateCheck).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'legacy'] as const)(
    'completes a genuine unique live owner: %s',
    async (format) => {
      const owner = await fixture();
      mocks.getCheck.mockResolvedValue({
        data: {
          head_sha: head,
          external_id: `roomote-review:${owner.run.id}`,
          status: 'in_progress',
        },
      });
      mocks.getComment.mockResolvedValue({
        data: { body: body(format, owner.task.id), updated_at: updatedAt },
      });
      await queuePrReviewSummaryNotification(
        payload(
          body(format, owner.task.id),
          body(format, owner.task.id, false, true),
        ),
      );
      expect(mocks.updateCheck).toHaveBeenCalledOnce();
      expect(mocks.updateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: owner.checkId,
          status: 'completed',
          conclusion: 'success',
        }),
      );
    },
  );

  it('documents the remaining deletion window after provider dispatch', async () => {
    const owner = await fixture();
    mocks.getCheck.mockResolvedValue({
      data: {
        head_sha: head,
        external_id: `roomote-review:${owner.run.id}`,
        status: 'in_progress',
      },
    });
    mocks.getComment.mockResolvedValue({
      data: { body: body('session', owner.task.id), updated_at: updatedAt },
    });
    mocks.updateCheck.mockImplementationOnce(async () => {
      // The final local validation has already passed and the remote PATCH is
      // in flight. Real deletion still commits while the Redis lock is held.
      expect(
        await getRedis().exists(`pr-review-synchronize:${repository}:42`),
      ).toBe(1);
      await db
        .update(tasks)
        .set({ deletedAt: new Date() })
        .where(eq(tasks.id, owner.task.id));
      const deleted = await db.query.tasks.findFirst({
        where: eq(tasks.id, owner.task.id),
        columns: { deletedAt: true },
      });
      expect(deleted?.deletedAt).toBeTruthy();
      console.log(
        'LIMITATION_OBSERVATION',
        JSON.stringify({
          check: owner.checkId,
          providerDispatchAlreadyStarted: true,
          deletionCommittedWhileLifecycleLockHeld: true,
        }),
      );
    });
    await queuePrReviewSummaryNotification(
      payload(
        body('session', owner.task.id),
        body('session', owner.task.id, false, true),
      ),
    );
    expect(mocks.updateCheck).toHaveBeenCalledOnce();
  });
});
