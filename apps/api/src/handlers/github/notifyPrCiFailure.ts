import { getInstallationOctokit } from '@roomote/github';
import { db, eq, taskRuns } from '@roomote/db/server';
import {
  enqueuePrReviewNotification,
  type EnqueuePrReviewNotificationInput,
} from '@roomote/sdk/server';

import type { WebhookCheckRunCompleted } from './types';

const FAILED_CHECK_CONCLUSIONS = new Set([
  'action_required',
  'failure',
  'startup_failure',
  'timed_out',
]);

function getObservedAt(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function buildPrCiFailureNotificationInputs(
  payload: WebhookCheckRunCompleted,
  pullRequestNumbers = payload.check_run.pull_requests.map(
    (pullRequest) => pullRequest.number,
  ),
  options: { reviewCycleId?: string; roomoteAuthored?: boolean } = {},
): EnqueuePrReviewNotificationInput[] {
  const checkRun = payload.check_run;

  if (
    !checkRun.conclusion ||
    !FAILED_CHECK_CONCLUSIONS.has(checkRun.conclusion)
  ) {
    return [];
  }

  const prNumbers = [...new Set(pullRequestNumbers)];

  return prNumbers.map((prNumber) => ({
    repository: payload.repository.full_name,
    prNumber,
    prUrl: `${payload.repository.html_url}/pull/${prNumber}`,
    sourceControlProvider: 'github',
    event: {
      kind: 'ci_failure',
      providerEventId: `github-check-run:${checkRun.id}`,
      authorLogin: checkRun.app?.slug ?? checkRun.app?.name ?? 'GitHub Checks',
      checkName: checkRun.name,
      reviewHeadSha: checkRun.head_sha,
      ...(options.roomoteAuthored ? { roomoteAuthored: true } : {}),
      ...(options.reviewCycleId
        ? {
            reviewCycleId: options.reviewCycleId,
            batchId: options.reviewCycleId,
          }
        : {}),
      url: checkRun.details_url || checkRun.html_url,
      observedAt: getObservedAt(checkRun.completed_at),
    },
  }));
}

async function resolveRoomoteReviewCycleId(
  payload: WebhookCheckRunCompleted,
): Promise<string | undefined> {
  if (payload.check_run.name !== 'Roomote code review') return undefined;
  const externalId = (payload.check_run as { external_id?: string })
    .external_id;
  const embeddedCycleId = /^roomote-review:\d+:(.+)$/.exec(
    externalId ?? '',
  )?.[1];
  if (embeddedCycleId) return embeddedCycleId;
  const runId = Number(
    /^roomote-review:(\d+)$/.exec(
      (payload.check_run as { external_id?: string }).external_id ?? '',
    )?.[1],
  );
  if (!Number.isSafeInteger(runId) || runId <= 0) return undefined;
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { payload: true },
  });
  const reviewCycleId = (run?.payload as { reviewCycleId?: unknown } | null)
    ?.reviewCycleId;
  return typeof reviewCycleId === 'string' && reviewCycleId.length > 0
    ? reviewCycleId
    : undefined;
}

async function resolvePullRequestNumbers(
  payload: WebhookCheckRunCompleted,
): Promise<number[]> {
  const associatedPrNumbers = payload.check_run.pull_requests.map(
    (pullRequest) => pullRequest.number,
  );

  if (associatedPrNumbers.length > 0) {
    return associatedPrNumbers;
  }

  const installationId = payload.installation?.id;
  const [owner, repo] = payload.repository.full_name.split('/');

  if (!installationId || !owner || !repo) {
    throw new Error(
      `Cannot resolve pull requests for ${payload.repository.full_name}@${payload.check_run.head_sha}`,
    );
  }

  const octokit = await getInstallationOctokit({ installationId });
  const pullRequests = await octokit.paginate(
    octokit.rest.repos.listPullRequestsAssociatedWithCommit,
    {
      owner,
      repo,
      commit_sha: payload.check_run.head_sha,
      per_page: 100,
    },
  );

  return pullRequests
    .filter(
      (pullRequest) =>
        pullRequest.state === 'open' &&
        pullRequest.head.sha === payload.check_run.head_sha,
    )
    .map((pullRequest) => pullRequest.number);
}

/** Persists failed GitHub checks for every associated task-linked PR. */
export async function queuePrCiFailureNotification(
  payload: WebhookCheckRunCompleted,
): Promise<void> {
  if (
    !payload.check_run.conclusion ||
    !FAILED_CHECK_CONCLUSIONS.has(payload.check_run.conclusion)
  ) {
    return;
  }

  const pullRequestNumbers = await resolvePullRequestNumbers(payload);
  const reviewCycleId = await resolveRoomoteReviewCycleId(payload);
  const inputs = buildPrCiFailureNotificationInputs(
    payload,
    pullRequestNumbers,
    {
      reviewCycleId,
      roomoteAuthored: payload.check_run.name === 'Roomote code review',
    },
  );

  await Promise.all(
    inputs.map((input) =>
      enqueuePrReviewNotification(input).catch((error) => {
        console.warn(
          `[queuePrCiFailureNotification] Failed to persist CI failure notification for ${input.repository}#${input.prNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }),
    ),
  );
}
