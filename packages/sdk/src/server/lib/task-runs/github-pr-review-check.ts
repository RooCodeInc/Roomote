import { RunStatus } from '@roomote/types';
import {
  and,
  db,
  eq,
  taskPullRequests,
  taskRuns,
  type TaskPullRequest,
} from '@roomote/db/server';
import {
  getMarkedSection,
  getTaskUrl,
  isReviewInProgressStatusLine,
  isSafetyNetReviewStatusLine,
  parseReviewSummaryMarkerSha,
  REVIEW_CHECKLIST_END_MARKER,
  REVIEW_CHECKLIST_START_MARKER,
  REVIEW_STATUS_END_MARKER,
  REVIEW_STATUS_START_MARKER,
  REVIEW_SUMMARY_MARKER,
} from '@roomote/cloud-agents/server';
import { getInstallationOctokit, updateCheckRun } from '@roomote/github';

export const GITHUB_PR_REVIEW_CHECK_NAME = 'Roomote code review';

function splitRepository(repository: string) {
  const [owner, repo] = repository.split('/');
  return owner && repo ? { owner, repo } : null;
}

function getReviewTaskUrl(taskId: string) {
  return getTaskUrl({
    taskId,
    utm: {
      source: 'github-check',
      medium: 'link',
      campaign: 'github.pr.review',
    },
  });
}

type ReviewSummaryClassification =
  | { kind: 'missing' }
  | { kind: 'stale' }
  | { kind: 'pending' }
  | { kind: 'terminal'; reviewStatus: string; reviewSummaryBody: string };

function classifyReviewSummary(input: {
  reviewSummaryBody?: string;
  expectedHeadSha?: string;
}): ReviewSummaryClassification {
  if (!input.reviewSummaryBody?.trim().startsWith(REVIEW_SUMMARY_MARKER)) {
    return { kind: 'missing' };
  }

  const reviewedHeadSha = parseReviewSummaryMarkerSha(input.reviewSummaryBody);
  if (
    input.expectedHeadSha &&
    (!reviewedHeadSha || !input.expectedHeadSha.startsWith(reviewedHeadSha))
  ) {
    return { kind: 'stale' };
  }

  const reviewStatus = getMarkedSection({
    content: input.reviewSummaryBody,
    startMarker: REVIEW_STATUS_START_MARKER,
    endMarker: REVIEW_STATUS_END_MARKER,
  });
  if (!reviewStatus || isReviewInProgressStatusLine(reviewStatus)) {
    return { kind: 'pending' };
  }

  return {
    kind: 'terminal',
    reviewStatus,
    reviewSummaryBody: input.reviewSummaryBody,
  };
}

function getTerminalReviewSummaryResult(input: {
  reviewSummaryBody?: string;
  expectedHeadSha: string;
}) {
  const classification = classifyReviewSummary(input);
  if (classification.kind !== 'terminal') {
    return null;
  }

  // A safety-net status ("Review could not be completed." etc.) marks a run
  // that never published a real result; only the run-status-driven path knows
  // the correct conclusion for it.
  if (isSafetyNetReviewStatusLine(classification.reviewStatus)) {
    return null;
  }

  return getGithubPrReviewCheckResult({
    runStatus: RunStatus.Completed,
    reviewSummaryBody: input.reviewSummaryBody,
    safetyNetFinalized: false,
    expectedHeadSha: input.expectedHeadSha,
  });
}

async function findGithubPrLinkage(input: {
  taskId: string;
  repository?: string;
  prNumber?: number;
}): Promise<TaskPullRequest | undefined> {
  return db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.taskId, input.taskId),
      eq(taskPullRequests.sourceControlProvider, 'github'),
      ...(input.repository
        ? [eq(taskPullRequests.repository, input.repository)]
        : []),
      ...(input.prNumber
        ? [eq(taskPullRequests.prNumber, input.prNumber)]
        : []),
    ),
  });
}

async function completeCheckRunWithResult(input: {
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
  repository: { owner: string; repo: string };
  checkRunId: number;
  result: {
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
  };
  taskUrl: string;
}): Promise<void> {
  await input.octokit.rest.checks.update({
    ...input.repository,
    check_run_id: input.checkRunId,
    status: 'completed',
    conclusion: input.result.conclusion,
    completed_at: new Date().toISOString(),
    details_url: input.taskUrl,
    output: {
      title: input.result.title,
      summary: `${input.result.summary} [Open the task](${input.taskUrl}).`,
    },
  });
}

export async function publishGithubPrReviewCheck(input: {
  installationId: number;
  repository: string;
  prNumber: number;
  headSha: string;
  taskId: string;
  runId: number;
  status?: 'queued' | 'in_progress';
}): Promise<void> {
  const repository = splitRepository(input.repository);
  if (!repository) {
    return;
  }

  try {
    const existingLinkage = await findGithubPrLinkage(input);
    const octokit = await getInstallationOctokit({
      installationId: input.installationId,
    });
    const taskUrl = getReviewTaskUrl(input.taskId);
    const status = input.status ?? 'queued';
    const { data: checkRun } = await octokit.rest.checks.create({
      ...repository,
      name: GITHUB_PR_REVIEW_CHECK_NAME,
      head_sha: input.headSha,
      status,
      ...(status === 'in_progress'
        ? { started_at: new Date().toISOString() }
        : {}),
      details_url: taskUrl,
      external_id: `roomote-review:${input.runId}`,
      output: {
        title:
          status === 'in_progress'
            ? 'Roomote review in progress'
            : 'Roomote review queued',
        summary:
          status === 'in_progress'
            ? `Roomote is reviewing this commit. [Open the task](${taskUrl}).`
            : `Roomote is queued to review this commit. [Open the task](${taskUrl}).`,
      },
    });

    await db
      .update(taskPullRequests)
      .set({ githubCheckRunId: checkRun.id, updatedAt: new Date() })
      .where(
        and(
          eq(taskPullRequests.taskId, input.taskId),
          eq(taskPullRequests.sourceControlProvider, 'github'),
          eq(taskPullRequests.repository, input.repository),
          eq(taskPullRequests.prNumber, input.prNumber),
        ),
      );

    try {
      const currentLinkage = await findGithubPrLinkage(input);
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, input.runId),
        columns: { startedAt: true, status: true },
      });

      // Only a run that actually executed can own the summary comment's
      // terminal result. A freshly enqueued same-head re-review (Pending)
      // must not be completed from the previous review's summary.
      const canCompleteFromSummary =
        run?.startedAt != null &&
        (run.status === RunStatus.Running || run.status === RunStatus.Idle);

      let reviewSummaryBody: string | undefined;
      if (
        currentLinkage?.githubReviewCommentId &&
        (run?.status === RunStatus.Completed || canCompleteFromSummary)
      ) {
        try {
          const { data: comment } = await octokit.rest.issues.getComment({
            ...repository,
            comment_id: currentLinkage.githubReviewCommentId,
          });
          reviewSummaryBody = comment.body ?? undefined;
        } catch (error) {
          console.error(
            `[githubPrReviewCheck] Failed to load review summary for run ${input.runId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const result =
        run?.status === RunStatus.Completed ||
        run?.status === RunStatus.Failed ||
        run?.status === RunStatus.Canceled
          ? getGithubPrReviewCheckResult({
              runStatus: run.status,
              reviewSummaryBody,
              safetyNetFinalized: false,
              expectedHeadSha: input.headSha,
            })
          : canCompleteFromSummary
            ? getTerminalReviewSummaryResult({
                reviewSummaryBody,
                expectedHeadSha: input.headSha,
              })
            : null;

      if (result) {
        await completeCheckRunWithResult({
          octokit,
          repository,
          checkRunId: checkRun.id,
          result,
          taskUrl,
        });
      } else if (status === 'queued' && run?.startedAt) {
        await octokit.rest.checks.update({
          ...repository,
          check_run_id: checkRun.id,
          status: 'in_progress',
          started_at: run.startedAt.toISOString(),
          details_url: taskUrl,
          output: {
            title: 'Roomote review in progress',
            summary: `Roomote is reviewing this commit. [Open the task](${taskUrl}).`,
          },
        });
      }
    } catch (error) {
      console.error(
        `[githubPrReviewCheck] Failed to reconcile run ${input.runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (
      existingLinkage?.githubCheckRunId &&
      existingLinkage.githubCheckRunId !== checkRun.id
    ) {
      await octokit.rest.checks.update({
        ...repository,
        check_run_id: existingLinkage.githubCheckRunId,
        status: 'completed',
        conclusion: 'cancelled',
        completed_at: new Date().toISOString(),
        output: {
          title: 'Superseded by a newer commit',
          summary:
            'Roomote started a new review for a newer pull request head.',
        },
      });
    }
  } catch (error) {
    console.error(
      `[githubPrReviewCheck] Failed to publish queued check for run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function completeGithubPrReviewCheckFromSummary(input: {
  installationId: number;
  repository: string;
  prNumber: number;
  taskId: string;
  reviewHeadSha: string;
  reviewSummaryBody: string;
}): Promise<void> {
  const repository = splitRepository(input.repository);
  if (!repository) {
    return;
  }

  // Best-effort like the other check publishers: a checks-API failure must
  // not fail the webhook delivery that carried the summary.
  try {
    // Cheap pre-filter on the webhook's body snapshot before any DB/API work.
    if (
      !getTerminalReviewSummaryResult({
        reviewSummaryBody: input.reviewSummaryBody,
        expectedHeadSha: input.reviewHeadSha,
      })
    ) {
      return;
    }

    const linkage = await findGithubPrLinkage(input);
    if (!linkage?.githubCheckRunId || !linkage.githubReviewCommentId) {
      return;
    }

    const octokit = await getInstallationOctokit({
      installationId: input.installationId,
    });
    const { data: checkRun } = await octokit.rest.checks.get({
      ...repository,
      check_run_id: linkage.githubCheckRunId,
    });
    if (
      checkRun.status === 'completed' ||
      !checkRun.head_sha.startsWith(input.reviewHeadSha)
    ) {
      return;
    }

    // Bind completion to the review cycle that owns the current check: a
    // delayed webhook for an earlier same-SHA cycle must not settle a newer
    // cycle's check. The check's external_id carries its run id.
    const owningRunId = Number(
      /^roomote-review:(\d+)$/.exec(checkRun.external_id ?? '')?.[1],
    );
    if (Number.isFinite(owningRunId)) {
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, owningRunId),
        columns: { startedAt: true, status: true },
      });
      const runCanOwnSummary =
        run?.startedAt != null &&
        (run.status === RunStatus.Running ||
          run.status === RunStatus.Idle ||
          run.status === RunStatus.Completed);
      if (!runCanOwnSummary) {
        return;
      }
    }

    // Decide from the live comment, not the webhook snapshot: if a newer
    // same-SHA cycle already reset the summary to in-progress, this yields
    // null and the delayed terminal snapshot is ignored.
    const { data: liveComment } = await octokit.rest.issues.getComment({
      ...repository,
      comment_id: linkage.githubReviewCommentId,
    });
    const result = getTerminalReviewSummaryResult({
      reviewSummaryBody: liveComment.body ?? undefined,
      expectedHeadSha: checkRun.head_sha,
    });
    if (!result) {
      return;
    }

    await completeCheckRunWithResult({
      octokit,
      repository,
      checkRunId: linkage.githubCheckRunId,
      result,
      taskUrl: getReviewTaskUrl(input.taskId),
    });
  } catch (error) {
    console.error(
      `[githubPrReviewCheck] Failed to complete check from summary for task ${input.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function markGithubPrReviewCheckInProgress(input: {
  taskId: string;
  gitHubToken: string;
}): Promise<void> {
  try {
    const linkage = await findGithubPrLinkage(input);
    if (!linkage?.githubCheckRunId || !linkage.repository) {
      return;
    }

    const repository = splitRepository(linkage.repository);
    if (!repository) {
      return;
    }

    const taskUrl = getReviewTaskUrl(input.taskId);
    await updateCheckRun(input.gitHubToken, {
      ...repository,
      check_run_id: linkage.githubCheckRunId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      details_url: taskUrl,
      output: {
        title: 'Roomote review in progress',
        summary: `Roomote is reviewing this commit. [Open the task](${taskUrl}).`,
      },
    });
  } catch (error) {
    console.error(
      `[githubPrReviewCheck] Failed to start check for task ${input.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function getGithubPrReviewCheckResult(input: {
  runStatus: RunStatus.Completed | RunStatus.Failed | RunStatus.Canceled;
  reviewSummaryBody?: string;
  safetyNetFinalized: boolean;
  expectedHeadSha?: string;
}): {
  conclusion: 'success' | 'failure' | 'cancelled';
  title: string;
  summary: string;
} {
  if (input.runStatus === RunStatus.Failed) {
    return {
      conclusion: 'failure',
      title: 'Roomote review failed',
      summary: 'Roomote could not complete this code review.',
    };
  }

  if (input.runStatus === RunStatus.Canceled) {
    return {
      conclusion: 'cancelled',
      title: 'Roomote review canceled',
      summary: 'This Roomote code review was canceled.',
    };
  }

  const classification = classifyReviewSummary(input);

  if (classification.kind === 'missing' || input.safetyNetFinalized) {
    return {
      conclusion: 'failure',
      title: 'Roomote review result unavailable',
      summary: 'The task completed without publishing a review result.',
    };
  }

  if (classification.kind === 'stale') {
    return {
      conclusion: 'failure',
      title: 'Roomote review result is stale',
      summary:
        'The published review result does not cover the latest pull request commit.',
    };
  }

  if (classification.kind === 'pending') {
    return {
      conclusion: 'failure',
      title: 'Roomote review result unavailable',
      summary: 'The task completed without publishing a review result.',
    };
  }

  const checklist = getMarkedSection({
    content: classification.reviewSummaryBody,
    startMarker: REVIEW_CHECKLIST_START_MARKER,
    endMarker: REVIEW_CHECKLIST_END_MARKER,
  });
  const hasUnresolvedFindings = /^\s*[-*]\s+\[\s\]/im.test(checklist ?? '');
  return hasUnresolvedFindings
    ? {
        conclusion: 'failure',
        title: 'Roomote found issues',
        summary:
          'The review has unresolved findings. Open the review summary for details.',
      }
    : {
        conclusion: 'success',
        title: 'Roomote review passed',
        summary: 'Roomote found no unresolved issues in this review.',
      };
}
