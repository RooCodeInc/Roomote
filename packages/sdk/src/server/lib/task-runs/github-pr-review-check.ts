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
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, input.runId),
        columns: { startedAt: true, status: true },
      });

      if (
        run?.status === RunStatus.Completed ||
        run?.status === RunStatus.Failed ||
        run?.status === RunStatus.Canceled
      ) {
        let reviewSummaryBody: string | undefined;
        if (
          run.status === RunStatus.Completed &&
          existingLinkage?.githubReviewCommentId
        ) {
          try {
            const { data: comment } = await octokit.rest.issues.getComment({
              ...repository,
              comment_id: existingLinkage.githubReviewCommentId,
            });
            reviewSummaryBody = comment.body ?? undefined;
          } catch (error) {
            console.error(
              `[githubPrReviewCheck] Failed to load review summary for settled run ${input.runId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        const result = getGithubPrReviewCheckResult({
          runStatus: run.status,
          reviewSummaryBody,
          safetyNetFinalized: false,
          expectedHeadSha: input.headSha,
        });
        await octokit.rest.checks.update({
          ...repository,
          check_run_id: checkRun.id,
          status: 'completed',
          conclusion: result.conclusion,
          completed_at: new Date().toISOString(),
          details_url: taskUrl,
          output: {
            title: result.title,
            summary: `${result.summary} [Open the task](${taskUrl}).`,
          },
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

  if (
    !input.reviewSummaryBody?.trim().startsWith(REVIEW_SUMMARY_MARKER) ||
    input.safetyNetFinalized
  ) {
    return {
      conclusion: 'failure',
      title: 'Roomote review result unavailable',
      summary: 'The task completed without publishing a review result.',
    };
  }

  const reviewedHeadSha = parseReviewSummaryMarkerSha(input.reviewSummaryBody);
  if (
    input.expectedHeadSha &&
    (!reviewedHeadSha || !input.expectedHeadSha.startsWith(reviewedHeadSha))
  ) {
    return {
      conclusion: 'failure',
      title: 'Roomote review result is stale',
      summary:
        'The published review result does not cover the latest pull request commit.',
    };
  }

  const reviewStatus = getMarkedSection({
    content: input.reviewSummaryBody,
    startMarker: REVIEW_STATUS_START_MARKER,
    endMarker: REVIEW_STATUS_END_MARKER,
  });
  if (!reviewStatus || isReviewInProgressStatusLine(reviewStatus)) {
    return {
      conclusion: 'failure',
      title: 'Roomote review result unavailable',
      summary: 'The task completed without publishing a review result.',
    };
  }

  const checklist = getMarkedSection({
    content: input.reviewSummaryBody,
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
