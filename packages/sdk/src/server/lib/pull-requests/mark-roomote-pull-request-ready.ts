import { createGitHubToken } from '@roomote/auth';
import {
  and,
  db,
  eq,
  getDeploymentMarkRoomotePrReadyAfterCleanReview,
  getDeploymentPrAction,
  taskPullRequests,
} from '@roomote/db/server';
import { getOctokit } from '@roomote/github';
import {
  supportsPullRequestDraftTransition,
  type SourceControlProvider,
} from '@roomote/types';

import {
  adoPullRequestSchema,
  bitbucketPullRequestSchema,
  giteaPullRequestSchema,
  gitLabMergeRequestSchema,
} from './source-control-pull-request-branch-lookup';
import { requestSourceControlJson as requestJson } from './source-control-pull-request-http';
import {
  resolveAdoProviderContext,
  resolveBitbucketProviderContext,
  resolveGiteaProviderContext,
  resolveGitLabProviderContext,
} from './source-control-pull-request-provider-context';
import {
  buildAdoBasicAuthHeader,
  buildApiUrl,
  buildGitLabTokenHeader,
  isDraftTitle,
  isGitLabDraft,
  resolveRepositoryRow,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';
import { updateTaskPrStatus } from './update-task-pr-status';
import { acquireGithubPrReviewLifecycleLock } from '../task-runs/github-pr-review-check';

const ADO_API_VERSION = '7.1';

type ReviewResult = {
  outcome: string | null;
  findingCount: number | null;
  headSha: string | null;
};

export type MarkRoomotePullRequestReadyResult =
  | 'marked_ready'
  | 'already_ready'
  | 'disabled'
  | 'unsupported'
  | 'not_roomote_created'
  | 'review_not_clean'
  | 'pull_request_not_open'
  | 'head_changed';

type TransitionInput = {
  repository: RepositoryRow;
  prNumber: number;
  reviewHeadSha: string;
  fetchImpl: FetchImpl;
};

/**
 * Promotes a Roomote-created draft after its persisted terminal review result
 * is clean. Every provider re-reads and verifies the remote head before and
 * after mutation; unsupported capability or response shapes fail closed.
 */
export async function markRoomotePullRequestReadyAfterCleanReview(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  host?: string;
  prNumber: number;
  reviewHeadSha: string;
  reviewResult: ReviewResult;
  fetchImpl?: FetchImpl;
}): Promise<MarkRoomotePullRequestReadyResult> {
  const [enabled, prAction] = await Promise.all([
    getDeploymentMarkRoomotePrReadyAfterCleanReview(),
    getDeploymentPrAction(),
  ]);
  if (!enabled || prAction !== 'draft') {
    return 'disabled';
  }
  if (!supportsPullRequestDraftTransition(input.sourceControlProvider)) {
    return 'unsupported';
  }
  if (
    input.reviewResult.outcome !== 'clean' ||
    (input.reviewResult.findingCount !== null &&
      input.reviewResult.findingCount !== 0) ||
    input.reviewResult.headSha !== input.reviewHeadSha
  ) {
    return 'review_not_clean';
  }

  const repository = await resolveRepositoryRow({
    provider: input.sourceControlProvider,
    repositoryFullName: input.repository,
    host: input.host,
  });
  const association = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
      eq(taskPullRequests.repositoryId, repository.id),
      eq(taskPullRequests.prNumber, input.prNumber),
      eq(taskPullRequests.createdByRoomote, true),
    ),
    columns: { id: true },
  });
  if (!association) {
    return 'not_roomote_created';
  }

  const releaseLifecycleLock = await acquireGithubPrReviewLifecycleLock(
    `${input.sourceControlProvider}:${repository.host ?? ''}:${input.repository}`,
    input.prNumber,
  );
  if (!releaseLifecycleLock) {
    throw new Error(
      `Timed out serializing ready transition for ${input.repository}#${input.prNumber}`,
    );
  }

  try {
    const transitionInput = {
      repository,
      prNumber: input.prNumber,
      reviewHeadSha: input.reviewHeadSha,
      fetchImpl: input.fetchImpl ?? fetch,
    };
    const result = await markProviderPullRequestReady(
      input.sourceControlProvider,
      transitionInput,
    );
    if (result === 'marked_ready' || result === 'already_ready') {
      await updateTaskPrStatus(
        input.sourceControlProvider,
        input.repository,
        input.prNumber,
        'open',
      );
    }
    return result;
  } finally {
    await releaseLifecycleLock();
  }
}

async function markProviderPullRequestReady(
  provider: SourceControlProvider,
  input: TransitionInput,
): Promise<MarkRoomotePullRequestReadyResult> {
  switch (provider) {
    case 'github':
      return markGitHubPullRequestReady(input);
    case 'gitlab':
      return markGitLabMergeRequestReady(input);
    case 'gitea':
      return markGiteaPullRequestReady(input);
    case 'ado':
      return markAdoPullRequestReady(input);
    case 'bitbucket':
      return markBitbucketPullRequestReady(input);
  }
}

async function markGitHubPullRequestReady(
  input: TransitionInput,
): Promise<MarkRoomotePullRequestReadyResult> {
  if (!input.repository.installationId) {
    throw new Error(
      `GitHub repository ${input.repository.fullName} is missing an installation id.`,
    );
  }
  const [owner, repo] = splitRepositoryFullName(
    input.repository.fullName,
    'github',
  );
  const token = await createGitHubToken({
    type: 'installationId',
    installationId: input.repository.installationId,
  });
  const octokit = getOctokit(token, { retryRateLimits: true });
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: input.prNumber,
  });
  if (pullRequest.state !== 'open') return 'pull_request_not_open';
  if (pullRequest.head.sha !== input.reviewHeadSha) return 'head_changed';
  if (!pullRequest.draft) return 'already_ready';

  let result: MarkRoomotePullRequestReadyResult = 'marked_ready';
  let mutationResult:
    | {
        markPullRequestReadyForReview?: {
          pullRequest?: { headRefOid: string; isDraft: boolean } | null;
        } | null;
      }
    | undefined;
  try {
    mutationResult = await octokit.graphql(
      `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest { headRefOid isDraft }
        }
      }`,
      { pullRequestId: pullRequest.node_id },
    );
  } catch (error) {
    const { data: currentPullRequest } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: input.prNumber,
    });
    if (
      currentPullRequest.state !== 'open' ||
      currentPullRequest.draft ||
      currentPullRequest.head.sha !== input.reviewHeadSha
    ) {
      throw error;
    }
    result = 'already_ready';
  }

  const markedPullRequest =
    mutationResult?.markPullRequestReadyForReview?.pullRequest;
  if (
    result === 'marked_ready' &&
    (!markedPullRequest || markedPullRequest.isDraft)
  ) {
    throw new Error(
      `GitHub did not confirm ready transition for ${input.repository.fullName}#${input.prNumber}`,
    );
  }
  if (
    result === 'marked_ready' &&
    markedPullRequest?.headRefOid !== input.reviewHeadSha
  ) {
    await octokit.graphql(
      `mutation ConvertPullRequestToDraft($pullRequestId: ID!) {
        convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
          pullRequest { isDraft }
        }
      }`,
      { pullRequestId: pullRequest.node_id },
    );
    return 'head_changed';
  }
  return result;
}

async function markGitLabMergeRequestReady(
  input: TransitionInput,
): Promise<MarkRoomotePullRequestReadyResult> {
  const { apiBaseUrl, projectId, token } = await resolveGitLabProviderContext(
    input.repository,
    'write',
  );
  const url = buildApiUrl(
    apiBaseUrl,
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${input.prNumber}`,
    {},
  );
  const tokenHeader = buildGitLabTokenHeader(token);
  const current = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'GET',
    url,
    tokenHeader,
    schema: gitLabMergeRequestSchema,
  });
  if (current.state !== 'opened') return 'pull_request_not_open';
  if (current.sha !== input.reviewHeadSha) return 'head_changed';
  if (!isGitLabDraft(current)) return 'already_ready';
  const readyTitle = removeDraftTitlePrefix(current.title);
  if (readyTitle === current.title) return 'unsupported';

  const updated = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'PUT',
    url,
    tokenHeader,
    body: { title: readyTitle },
    schema: gitLabMergeRequestSchema,
  });
  if (updated.sha !== input.reviewHeadSha) {
    if (!isGitLabDraft(updated)) {
      await requestJson({
        fetchImpl: input.fetchImpl,
        method: 'PUT',
        url,
        tokenHeader,
        body: { title: current.title },
        schema: gitLabMergeRequestSchema,
      });
    }
    return 'head_changed';
  }
  if (isGitLabDraft(updated)) {
    throw new Error(
      `GitLab did not confirm ready transition for ${input.repository.fullName}!${input.prNumber}`,
    );
  }
  return 'marked_ready';
}

async function markGiteaPullRequestReady(
  input: TransitionInput,
): Promise<MarkRoomotePullRequestReadyResult> {
  const { apiBaseUrl, owner, repo, token } = await resolveGiteaProviderContext(
    input.repository,
    'write',
  );
  const url = buildApiUrl(
    apiBaseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}`,
    {},
  );
  const tokenHeader = { name: 'Authorization', value: `token ${token}` };
  const current = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'GET',
    url,
    tokenHeader,
    schema: giteaPullRequestSchema,
  });
  if (current.state !== 'open') return 'pull_request_not_open';
  if (current.head?.sha !== input.reviewHeadSha) return 'head_changed';
  const hasDraftTitle = isDraftTitle(current.title);
  if (!hasDraftTitle && current.draft !== true) return 'already_ready';
  if (!hasDraftTitle) return 'unsupported';
  const readyTitle = removeDraftTitlePrefix(current.title ?? '');

  const updated = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'PATCH',
    url,
    tokenHeader,
    body: { title: readyTitle },
    schema: giteaPullRequestSchema,
  });
  if (updated.head?.sha !== input.reviewHeadSha) {
    if (!isDraftTitle(updated.title)) {
      await requestJson({
        fetchImpl: input.fetchImpl,
        method: 'PATCH',
        url,
        tokenHeader,
        body: { title: current.title },
        schema: giteaPullRequestSchema,
      });
    }
    return 'head_changed';
  }
  if (isDraftTitle(updated.title) || updated.draft === true) {
    throw new Error(
      `Gitea did not confirm ready transition for ${input.repository.fullName}#${input.prNumber}`,
    );
  }
  return 'marked_ready';
}

async function markBitbucketPullRequestReady(
  input: TransitionInput,
): Promise<MarkRoomotePullRequestReadyResult> {
  const { apiBaseUrl, authHeader, workspace, repo } =
    await resolveBitbucketProviderContext(input.repository, 'write');
  const url = buildApiUrl(
    apiBaseUrl,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${input.prNumber}`,
    {},
  );
  const tokenHeader = { name: 'Authorization', value: authHeader };
  const current = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'GET',
    url,
    tokenHeader,
    schema: bitbucketPullRequestSchema,
  });
  if (current.state !== 'OPEN') return 'pull_request_not_open';
  if (current.source?.commit?.hash !== input.reviewHeadSha)
    return 'head_changed';
  if (typeof current.draft !== 'boolean') return 'unsupported';
  if (!current.draft) return 'already_ready';

  const updated = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'PUT',
    url,
    tokenHeader,
    body: { draft: false },
    schema: bitbucketPullRequestSchema,
  });
  if (updated.source?.commit?.hash !== input.reviewHeadSha) {
    if (!updated.draft) {
      await requestJson({
        fetchImpl: input.fetchImpl,
        method: 'PUT',
        url,
        tokenHeader,
        body: { draft: true },
        schema: bitbucketPullRequestSchema,
      });
    }
    return 'head_changed';
  }
  if (updated.draft !== false) {
    throw new Error(
      `Bitbucket did not confirm ready transition for ${input.repository.fullName}#${input.prNumber}`,
    );
  }
  return 'marked_ready';
}

async function markAdoPullRequestReady(
  input: TransitionInput,
): Promise<MarkRoomotePullRequestReadyResult> {
  const { organizationApiBaseUrl, repositoryPullRequestsPath, token } =
    await resolveAdoProviderContext(input.repository, 'write');
  const url = buildApiUrl(
    organizationApiBaseUrl,
    `${repositoryPullRequestsPath}/${input.prNumber}`,
    { 'api-version': ADO_API_VERSION },
  );
  const tokenHeader = {
    name: 'Authorization',
    value: buildAdoBasicAuthHeader(token),
  };
  const current = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'GET',
    url,
    tokenHeader,
    schema: adoPullRequestSchema,
  });
  if (current.status !== 'active') return 'pull_request_not_open';
  if (current.lastMergeSourceCommit?.commitId !== input.reviewHeadSha) {
    return 'head_changed';
  }
  if (typeof current.isDraft !== 'boolean') return 'unsupported';
  if (!current.isDraft) return 'already_ready';

  const updated = await requestJson({
    fetchImpl: input.fetchImpl,
    method: 'PATCH',
    url,
    tokenHeader,
    body: { isDraft: false },
    schema: adoPullRequestSchema,
  });
  if (updated.lastMergeSourceCommit?.commitId !== input.reviewHeadSha) {
    if (!updated.isDraft) {
      await requestJson({
        fetchImpl: input.fetchImpl,
        method: 'PATCH',
        url,
        tokenHeader,
        body: { isDraft: true },
        schema: adoPullRequestSchema,
      });
    }
    return 'head_changed';
  }
  if (updated.isDraft !== false) {
    throw new Error(
      `Azure DevOps did not confirm ready transition for ${input.repository.fullName}#${input.prNumber}`,
    );
  }
  return 'marked_ready';
}

function removeDraftTitlePrefix(title: string): string {
  return title.replace(/^(draft|wip):\s*/i, '').trim();
}
