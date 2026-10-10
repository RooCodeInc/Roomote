const mocks = vi.hoisted(() => ({
  getCheck: vi.fn(),
  getComment: vi.fn(),
  updateCheck: vi.fn(),
  enqueue: vi.fn().mockResolvedValue({ notifiedTaskCount: 1 }),
  promote: vi.fn().mockResolvedValue('review_not_clean'),
  start: vi.fn(),
  release: Object.assign(vi.fn(), {
    renewDetailed: vi.fn().mockResolvedValue('renewed'),
  }),
}));

vi.mock('@roomote/sdk/server', async () => ({
  // Exercise the real check reconciler, with only the GitHub/lock boundaries
  // substituted. Task, run and canonical-comment linkage queries use Postgres.
  completeGithubPrReviewCheckFromSummary: (
    await vi.importActual<typeof import('@roomote/sdk/server')>(
      '@roomote/sdk/server',
    )
  ).completeGithubPrReviewCheckFromSummary,
  enqueuePrReviewNotification: mocks.enqueue,
  markRoomotePullRequestReadyAfterCleanReview: mocks.promote,
  startPrReviewNotificationCycle: mocks.start,
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

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  acquireRedisLock: vi.fn().mockResolvedValue(mocks.release),
}));

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
import { RunStatus } from '@roomote/types';

import { queuePrReviewSummaryNotification } from '../notifyPrReviewActivity';

const head = '1234567890abcdef1234567890abcdef12345678';
const repository = 'review-check-regression/repo';
const commentId = 987654321;
const checkId = 987654322;
const startedAt = new Date('2026-10-10T12:00:00Z');
const updatedAt = '2026-10-10T12:02:00Z';
const taskIds: string[] = [];

function body(phase: 'reviewing' | 'reviewed', findings = false) {
  return [
    `<!-- roomote-review-summary sha=${head} mode=initial version=3 phase=${phase}${phase === 'reviewed' ? ` outcome=${findings ? 'findings_remain' : 'clean'} finding_count=${findings ? 1 : 0}` : ''} -->`,
    '<!-- roomote-review-status:start -->',
    `${phase === 'reviewing' ? 'Reviewing the PR now.' : findings ? '1 issue outstanding.' : 'No code issues found.'} [See session](https://roomote.test/sessions/11111111-1111-4111-8111-111111111111)`,
    '<!-- roomote-review-status:end -->',
    '<!-- roomote-review-checklist:start -->',
    findings ? '- [ ] An unresolved finding.' : '',
    '<!-- roomote-review-checklist:end -->',
  ].join('\n');
}

function payload(terminalBody: string, previousBody = body('reviewing')) {
  return {
    action: 'edited' as const,
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

async function fixture(status = RunStatus.Idle) {
  const task = await taskFactory.create();
  taskIds.push(task.id);
  const run = await runFactory.create({ taskId: task.id, status, startedAt });
  await db.insert(taskPullRequests).values({
    taskId: task.id,
    repository,
    prNumber: 42,
    prUrl: `https://github.com/${repository}/pull/42`,
    sourceControlProvider: 'github',
    githubReviewCommentId: commentId,
    githubCheckRunId: checkId,
  });
  mocks.getCheck.mockResolvedValue({
    data: {
      head_sha: head,
      external_id: `roomote-review:${run.id}`,
      status: 'in_progress',
    },
  });
  mocks.getComment.mockResolvedValue({
    data: { body: body('reviewed'), updated_at: updatedAt },
  });
  return { task, run };
}

describe('session-linked review summary check completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfiguredGitHubAppSlugCache({
      value: 'roomote',
      expiresAt: Date.now() + 60_000,
    });
  });

  afterEach(async () => {
    if (taskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
    }
    setConfiguredGitHubAppSlugCache(null);
  });

  it.each([RunStatus.Running, RunStatus.Idle, RunStatus.Completed])(
    'concludes a clean canonical session-linked summary for a %s run',
    async (status) => {
      const { task } = await fixture(status);
      await queuePrReviewSummaryNotification(payload(body('reviewed')));
      expect(mocks.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ reviewTaskId: task.id }),
        }),
      );
      expect(mocks.updateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: checkId,
          status: 'completed',
          conclusion: 'success',
        }),
      );
    },
  );

  it('reconciles a terminal rewrite without enqueueing another review notice', async () => {
    await fixture(RunStatus.Completed);
    await queuePrReviewSummaryNotification(
      payload(body('reviewed'), body('reviewed', true)),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.updateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', conclusion: 'success' }),
    );
  });

  it('retains the findings conclusion', async () => {
    await fixture();
    mocks.getComment.mockResolvedValue({
      data: { body: body('reviewed', true), updated_at: updatedAt },
    });
    await queuePrReviewSummaryNotification(payload(body('reviewed', true)));
    expect(mocks.updateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
    );
  });

  it('is idempotent when the check already matches the terminal rewrite', async () => {
    const { run } = await fixture(RunStatus.Completed);
    mocks.getCheck.mockResolvedValue({
      data: {
        head_sha: head,
        external_id: `roomote-review:${run.id}`,
        status: 'completed',
        conclusion: 'success',
        output: { title: 'Roomote review passed' },
      },
    });
    await queuePrReviewSummaryNotification(
      payload(body('reviewed'), body('reviewed')),
    );
    expect(mocks.updateCheck).not.toHaveBeenCalled();
  });

  it('does not replace an already-completed conclusion on initial completion', async () => {
    const { run } = await fixture();
    mocks.getCheck.mockResolvedValue({
      data: {
        head_sha: head,
        external_id: `roomote-review:${run.id}`,
        status: 'completed',
        conclusion: 'cancelled',
      },
    });
    await queuePrReviewSummaryNotification(payload(body('reviewed')));
    expect(mocks.updateCheck).not.toHaveBeenCalled();
  });

  it.each([
    'unlinked',
    'wrong repository',
    'wrong PR',
    'wrong provider',
    'ambiguous',
  ])(
    'does not infer the review owner from a session alone: %s',
    async (mismatch) => {
      const { task } = await fixture();
      if (mismatch === 'ambiguous') {
        await fixture();
      } else {
        await db
          .update(taskPullRequests)
          .set({
            ...(mismatch === 'unlinked'
              ? { githubReviewCommentId: commentId + 1 }
              : {}),
            ...(mismatch === 'wrong repository'
              ? { repository: 'other/repo' }
              : {}),
            ...(mismatch === 'wrong PR' ? { prNumber: 43 } : {}),
            ...(mismatch === 'wrong provider'
              ? { sourceControlProvider: 'gitlab' }
              : {}),
          })
          .where(eq(taskPullRequests.taskId, task.id));
      }
      await queuePrReviewSummaryNotification(payload(body('reviewed')));
      expect(mocks.updateCheck).not.toHaveBeenCalled();
    },
  );

  it.each([RunStatus.Failed, RunStatus.Canceled])(
    'preserves a %s owning run',
    async (status) => {
      await fixture(status);
      await queuePrReviewSummaryNotification(payload(body('reviewed')));
      expect(mocks.updateCheck).not.toHaveBeenCalled();
    },
  );

  it.each(['head', 'owner', 'pending summary', 'older summary'])(
    'retains the live %s fence',
    async (fence) => {
      const { run } = await fixture();
      if (fence === 'head' || fence === 'owner') {
        mocks.getCheck.mockResolvedValue({
          data: {
            status: 'in_progress',
            head_sha:
              fence === 'head'
                ? 'abcdef1234567890abcdef1234567890abcdef12'
                : head,
            external_id: `roomote-review:${fence === 'owner' ? run.id + 100000 : run.id}`,
          },
        });
      } else {
        mocks.getComment.mockResolvedValue({
          data: {
            body: body(fence === 'pending summary' ? 'reviewing' : 'reviewed'),
            updated_at:
              fence === 'older summary' ? '2026-10-10T11:00:00Z' : updatedAt,
          },
        });
      }
      await queuePrReviewSummaryNotification(payload(body('reviewed')));
      expect(mocks.updateCheck).not.toHaveBeenCalled();
    },
  );
});
