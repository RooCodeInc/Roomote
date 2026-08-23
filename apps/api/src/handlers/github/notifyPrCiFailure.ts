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
): EnqueuePrReviewNotificationInput[] {
  const checkRun = payload.check_run;

  if (
    !checkRun.conclusion ||
    !FAILED_CHECK_CONCLUSIONS.has(checkRun.conclusion)
  ) {
    return [];
  }

  const prNumbers = [
    ...new Set(checkRun.pull_requests.map((pullRequest) => pullRequest.number)),
  ];

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
      url: checkRun.details_url || checkRun.html_url,
      observedAt: getObservedAt(checkRun.completed_at),
    },
  }));
}

/** Persists failed GitHub checks for every associated task-linked PR. */
export async function queuePrCiFailureNotification(
  payload: WebhookCheckRunCompleted,
): Promise<void> {
  const inputs = buildPrCiFailureNotificationInputs(payload);

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
