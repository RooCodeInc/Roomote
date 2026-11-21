const mocks = vi.hoisted(() => ({
  createCheck: vi.fn(),
  getCheck: vi.fn(),
  updateCheck: vi.fn(),
  getComment: vi.fn(),
  enqueue: vi.fn(),
  followUp: vi.fn(),
  targets: vi.fn(),
  currentHead: vi.fn(),
  release: Object.assign(vi.fn(), {
    renewDetailed: vi.fn().mockResolvedValue('renewed'),
  }),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  enqueueTask: mocks.enqueue,
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  enqueueActivePrReviewFollowUp: mocks.followUp,
}));

vi.mock('@roomote/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/github')>()),
  getInstallationOctokit: vi.fn().mockResolvedValue({
    rest: {
      checks: {
        create: mocks.createCheck,
        get: mocks.getCheck,
        update: mocks.updateCheck,
      },
      issues: { getComment: mocks.getComment },
    },
  }),
}));

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  acquireRedisLock: vi.fn().mockResolvedValue(mocks.release),
}));

vi.mock('../getGitHubAutomationTargets', () => ({
  getGitHubAutomationTargets: mocks.targets,
}));
vi.mock('../currentPrHead', () => ({
  getCurrentGitHubPrHeadSha: mocks.currentHead,
}));

import {
  db,
  eq,
  inArray,
  runFactory,
  taskFactory,
  taskPullRequests,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { completeGithubPrReviewCheckFromSummary } from '@roomote/sdk/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { handlePrSynchronize } from '../handlePrSynchronize';
import type { WebhookPullRequestSynchronize } from '../types';

const repository = 'queued-review-check-retarget/repo';
const heads = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
const commentId = 372300;
const startedAt = new Date('2026-11-20T01:00:00Z');
const taskIds: string[] = [];

function summary(headSha: string) {
  return [
    `<!-- roomote-review-summary sha=${headSha} version=3 phase=reviewed outcome=clean finding_count=0 -->`,
    '<!-- roomote-review-status:start -->',
    'No code issues found.',
    '<!-- roomote-review-status:end -->',
  ].join('\n');
}

function synchronize(headSha: string) {
  return handlePrSynchronize({
    installation: { id: 1 },
    repository: { id: 2, full_name: repository },
    pull_request: {
      number: 42,
      title: 'Update feature',
      html_url: `https://github.com/${repository}/pull/42`,
      draft: false,
      locked: false,
      user: { login: 'review-author' },
      head: { ref: 'feature', sha: headSha },
      base: { ref: 'main', sha: 'base-sha' },
    },
    sender: { id: 3, login: 'review-author' },
  } as unknown as WebhookPullRequestSynchronize);
}

async function fixture() {
  const task = await taskFactory.create({ workflow: 'pr_review' });
  taskIds.push(task.id);
  const run = await runFactory.create({
    taskId: task.id,
    payloadKind: TaskPayloadKind.GithubPrReview,
    payload: { repo: repository, prNumber: 42, headSha: heads[0] },
    status: RunStatus.Pending,
    startedAt: null,
    sandboxServerUrl: null,
  });
  await db.insert(taskPullRequests).values({
    taskId: task.id,
    repository,
    prNumber: 42,
    prUrl: `https://github.com/${repository}/pull/42`,
    sourceControlProvider: 'github',
    prSha: heads[0],
    githubReviewCommentId: commentId,
    githubCheckRunId: 10,
  });
  mocks.createCheck.mockResolvedValue({ data: { id: 20 } });
  return { task, run };
}

async function completeSummary(taskId: string, headSha: string) {
  return completeGithubPrReviewCheckFromSummary({
    installationId: 1,
    repository,
    prNumber: 42,
    taskId,
    reviewHeadSha: headSha,
    reviewSummaryBody: summary(headSha),
  });
}

describe('queued review check retargeting (real DB and check lifecycle)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.targets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'review-target',
          settings: { reviewOnCommit: true, publishGithubCheck: true },
          repo: { id: 'repo-id', host: 'github.com' },
          properties: {},
        },
      ],
    });
    mocks.currentHead.mockResolvedValue(heads[1]);
  });

  afterEach(async () => {
    if (taskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
    }
  });

  it.each([1, 2])(
    'replaces queued checks across %i push(es), then completes only the latest head',
    async (pushCount) => {
      const { task, run } = await fixture();
      let checkId = 10;
      for (let push = 1; push <= pushCount; push++) {
        const previousCheckId = checkId;
        checkId += 10;
        mocks.currentHead.mockResolvedValue(heads[push]);
        mocks.createCheck.mockResolvedValue({ data: { id: checkId } });
        await synchronize(heads[push]!);

        expect(mocks.createCheck).toHaveBeenLastCalledWith(
          expect.objectContaining({
            head_sha: heads[push],
            status: 'queued',
            external_id: `roomote-review:${run.id}`,
            request: { signal: expect.any(AbortSignal) },
          }),
        );
        expect(
          await db.query.taskPullRequests.findFirst({
            where: eq(taskPullRequests.taskId, task.id),
          }),
        ).toMatchObject({ prSha: heads[push], githubCheckRunId: checkId });
        expect(
          await db.query.taskRuns.findFirst({
            where: eq(taskRuns.id, run.id),
          }),
        ).toMatchObject({ payload: { headSha: heads[push] } });
        expect(mocks.updateCheck).toHaveBeenCalledWith(
          expect.objectContaining({
            check_run_id: previousCheckId,
            status: 'completed',
            conclusion: 'cancelled',
          }),
        );
      }

      // Duplicate delivery for the live head does not publish another check.
      await synchronize(heads[pushCount]!);
      expect(mocks.createCheck).toHaveBeenCalledTimes(pushCount);
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(mocks.followUp).not.toHaveBeenCalled();

      await db
        .update(taskRuns)
        .set({
          status: RunStatus.Running,
          startedAt,
        })
        .where(eq(taskRuns.id, run.id));
      mocks.getCheck.mockResolvedValue({
        data: {
          head_sha: heads[pushCount],
          external_id: `roomote-review:${run.id}`,
          status: 'in_progress',
        },
      });
      mocks.getComment.mockResolvedValue({
        data: {
          body: summary(heads[pushCount]!),
          updated_at: '2026-11-20T01:02:00Z',
        },
      });
      mocks.updateCheck.mockClear();
      // An earlier commit's delayed summary must not complete the new check.
      await completeSummary(task.id, heads[pushCount - 1]!);
      expect(mocks.updateCheck).not.toHaveBeenCalled();
      await completeSummary(task.id, heads[pushCount]!);
      expect(mocks.getCheck).toHaveBeenLastCalledWith(
        expect.objectContaining({ check_run_id: checkId }),
      );
      expect(mocks.updateCheck).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          check_run_id: checkId,
          status: 'completed',
          conclusion: 'success',
        }),
      );
    },
  );

  it.each([RunStatus.Running, RunStatus.Completed])(
    'reconciles a retargeted check when its worker becomes %s during publication',
    async (status) => {
      const { task, run } = await fixture();
      mocks.createCheck.mockImplementationOnce(async () => {
        // The pending-head transaction has committed before the GitHub call.
        const currentRun = await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, run.id),
        });
        expect(currentRun?.payload).toMatchObject({ headSha: heads[1] });
        await db
          .update(taskRuns)
          .set({ status, startedAt })
          .where(eq(taskRuns.id, run.id));
        return { data: { id: 20 } };
      });
      mocks.getComment.mockResolvedValue({
        data: { body: summary(heads[1]!), updated_at: '2026-11-20T01:02:00Z' },
      });

      await synchronize(heads[1]!);

      expect(
        await db.query.taskPullRequests.findFirst({
          where: eq(taskPullRequests.taskId, task.id),
        }),
      ).toMatchObject({ prSha: heads[1], githubCheckRunId: 20 });
      expect(mocks.createCheck).toHaveBeenCalledOnce();
      expect(mocks.updateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 20,
          status: 'completed',
          conclusion: 'success',
        }),
      );
      expect(mocks.updateCheck).toHaveBeenCalledWith(
        expect.objectContaining({ check_run_id: 10, conclusion: 'cancelled' }),
      );
    },
  );
});
