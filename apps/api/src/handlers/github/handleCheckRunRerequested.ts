import {
  and,
  db,
  eq,
  taskPullRequests,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  getInstallationOctokit,
  resolveConfiguredGitHubAppSlug,
} from '@roomote/github';
import { GITHUB_PR_REVIEW_CHECK_NAME } from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';

import { handlePrOpen } from './handlePrOpen';
import type {
  WebhookCheckRunRerequested,
  WebhookPullRequestOpened,
} from './types';

function ignored(message: string): WebhookResponse {
  return { status: 'ok', message };
}

export async function handleCheckRunRerequested(
  payload: WebhookCheckRunRerequested,
): Promise<WebhookResponse> {
  const {
    check_run: requestedCheck,
    installation,
    repository,
    sender,
  } = payload;
  const installationId = installation?.id;
  const appSlug = (await resolveConfiguredGitHubAppSlug()).toLowerCase();

  // GitHub authorizes who may request a check re-run. The webhook route has
  // already verified the signature and installation; this gate additionally
  // limits the action to this deployment's exact check identity.
  if (
    !installationId ||
    requestedCheck.name !== GITHUB_PR_REVIEW_CHECK_NAME ||
    requestedCheck.app?.slug?.toLowerCase() !== appSlug
  ) {
    return ignored(
      'Ignoring a check that is not owned by Roomote code review.',
    );
  }

  const [owner, repo] = repository.full_name.split('/');
  if (!owner || !repo) {
    return ignored('Ignoring a check with invalid repository context.');
  }

  const octokit = await getInstallationOctokit({ installationId });
  const { data: check } = await octokit.rest.checks.get({
    owner,
    repo,
    check_run_id: requestedCheck.id,
  });
  const owningRunId = Number(
    /^roomote-review:(\d+)$/.exec(check.external_id ?? '')?.[1],
  );

  if (
    check.id !== requestedCheck.id ||
    check.name !== GITHUB_PR_REVIEW_CHECK_NAME ||
    check.app?.slug?.toLowerCase() !== appSlug ||
    check.status !== 'completed' ||
    !Number.isSafeInteger(owningRunId) ||
    owningRunId <= 0
  ) {
    return ignored('Ignoring a check without valid Roomote review ownership.');
  }

  const [linkedReview] = await db
    .select({
      prNumber: taskPullRequests.prNumber,
      prSha: taskPullRequests.prSha,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .innerJoin(
      taskRuns,
      and(
        eq(taskRuns.id, owningRunId),
        eq(taskRuns.taskId, taskPullRequests.taskId),
      ),
    )
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repository.full_name),
        eq(taskPullRequests.githubCheckRunId, check.id),
      ),
    )
    .limit(1);

  if (
    !linkedReview?.prNumber ||
    !linkedReview.prSha ||
    linkedReview.prSha !== check.head_sha
  ) {
    return ignored('Ignoring a check without current pull request linkage.');
  }

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: linkedReview.prNumber,
  });

  if (pullRequest.state !== 'open' || pullRequest.head.sha !== check.head_sha) {
    return ignored(
      'Ignoring a check that is not for the open pull request head.',
    );
  }

  return handlePrOpen(
    {
      installation,
      repository,
      sender,
      pull_request: pullRequest,
    } as WebhookPullRequestOpened,
    {
      isExplicitReviewRequest: true,
      expectedGithubCheckRunId: check.id,
      expectedHeadSha: check.head_sha,
    },
  );
}
