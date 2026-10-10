import { createGitHubToken } from '@roomote/auth';
import { getOctokit } from '@roomote/github';
import type { SourceControlProvider } from '@roomote/types';
import { z } from 'zod';
import {
  adoPullRequestSchema,
  bitbucketPullRequestSchema,
  giteaPullRequestSchema,
  gitLabMergeRequestSchema,
  normalizeAdoBranchRef,
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
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';

export type ProviderPullRequestState = {
  open: boolean;
  headSha?: string;
  draft?: boolean;
  title?: string;
  nativeDraft?: boolean;
  nodeId?: string;
  url?: string | null;
};

export type PullRequestChanges = {
  targetBranch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
};

type ProviderPullRequestUpdates = {
  read(): Promise<ProviderPullRequestState>;
  update(
    current: ProviderPullRequestState | undefined,
    changes: PullRequestChanges,
    signal?: AbortSignal,
  ): Promise<ProviderPullRequestState>;
};

// Transport and draft protocols live here; callers own intent, locking,
// reviewed-head policy, compensation and persistence.
export async function createProviderPullRequestUpdates(
  provider: SourceControlProvider,
  repository: RepositoryRow,
  prNumber: number,
  fetchImpl: FetchImpl,
): Promise<ProviderPullRequestUpdates> {
  if (provider === 'github') {
    if (!repository.installationId) {
      throw new Error(
        `GitHub repository ${repository.fullName} is missing an installation id.`,
      );
    }
    const [owner, repo] = splitRepositoryFullName(
      repository.fullName,
      provider,
    );
    const token = await createGitHubToken({
      type: 'installationId',
      installationId: repository.installationId,
    });
    const octokit = getOctokit(token, { retryRateLimits: true });
    const identity = { owner, repo, pull_number: prNumber };
    return {
      async read() {
        const { data } = await octokit.rest.pulls.get(identity);
        return {
          open: data.state === 'open',
          headSha: data.head?.sha,
          draft: data.draft,
          nodeId: data.node_id,
          url: data.html_url ?? null,
        };
      },
      async update(current, changes, signal) {
        if (!current)
          throw new Error('GitHub updates require the current pull request.');
        let updated = current;
        if (
          changes.targetBranch !== undefined ||
          changes.title !== undefined ||
          changes.body !== undefined
        ) {
          const { data } = await octokit.rest.pulls.update({
            ...identity,
            ...(changes.targetBranch !== undefined
              ? { base: changes.targetBranch }
              : {}),
            ...(changes.title !== undefined ? { title: changes.title } : {}),
            ...(changes.body !== undefined ? { body: changes.body } : {}),
          });
          updated = { ...current, url: data.html_url ?? current.url };
        }
        if (changes.draft !== undefined && changes.draft !== current.draft) {
          signal?.throwIfAborted();
          const response = await octokit.graphql(
            changes.draft
              ? `mutation ConvertPullRequestToDraft($pullRequestId: ID!) {
                  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
                    pullRequest { headRefOid isDraft }
                  }
                }`
              : `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
                  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
                    pullRequest { headRefOid isDraft }
                  }
                }`,
            { pullRequestId: current.nodeId },
          );
          const mutation = z
            .object({
              pullRequest: z
                .object({
                  isDraft: z.boolean(),
                  headRefOid: z.string().optional(),
                })
                .nullable(),
            })
            .safeParse(
              changes.draft
                ? (response as { convertPullRequestToDraft?: unknown } | null)
                    ?.convertPullRequestToDraft
                : (
                    response as {
                      markPullRequestReadyForReview?: unknown;
                    } | null
                  )?.markPullRequestReadyForReview,
            );
          const pullRequest = mutation.success
            ? mutation.data.pullRequest
            : undefined;
          updated = {
            ...updated,
            draft: pullRequest?.isDraft,
            headSha: pullRequest?.headRefOid,
          };
        }
        return updated;
      },
    };
  }

  // Share transport without erasing each provider's wire shape.
  function httpUpdates<T>(
    url: string,
    tokenHeader: { name: string; value: string },
    method: 'PUT' | 'PATCH',
    schema: z.ZodType<T>,
    state: (response: T) => ProviderPullRequestState,
    body: (
      current: ProviderPullRequestState | undefined,
      changes: PullRequestChanges,
    ) => Record<string, unknown>,
  ): ProviderPullRequestUpdates {
    return {
      async read() {
        return state(
          await requestJson({
            fetchImpl,
            method: 'GET',
            url,
            tokenHeader,
            schema,
          }),
        );
      },
      async update(current, changes, signal) {
        signal?.throwIfAborted();
        return state(
          await requestJson({
            fetchImpl,
            method,
            url,
            tokenHeader,
            schema,
            body: body(current, changes),
          }),
        );
      },
    };
  }

  switch (provider) {
    case 'gitlab': {
      const { apiBaseUrl, projectId, token } =
        await resolveGitLabProviderContext(repository, 'write');
      return httpUpdates(
        buildApiUrl(
          apiBaseUrl,
          `/projects/${encodeURIComponent(projectId)}/merge_requests/${prNumber}`,
          {},
        ),
        buildGitLabTokenHeader(token),
        'PUT',
        gitLabMergeRequestSchema,
        (data) => ({
          open: data.state === 'opened',
          headSha: data.sha,
          draft: isGitLabDraft(data),
          title: data.title,
        }),
        (current, changes) => ({
          ...(changes.targetBranch !== undefined
            ? { target_branch: changes.targetBranch }
            : {}),
          ...draftTitleUpdate(current, changes, 'Draft'),
          ...(changes.body !== undefined ? { description: changes.body } : {}),
        }),
      );
    }
    case 'gitea': {
      const { apiBaseUrl, owner, repo, token } =
        await resolveGiteaProviderContext(repository, 'write');
      return httpUpdates(
        buildApiUrl(
          apiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
          {},
        ),
        { name: 'Authorization', value: `token ${token}` },
        'PATCH',
        giteaPullRequestSchema,
        (data) => ({
          open: data.state === 'open',
          headSha: data.head?.sha,
          draft: Boolean(data.draft) || isDraftTitle(data.title),
          nativeDraft: data.draft,
          title: data.title,
        }),
        (current, changes) => ({
          ...(changes.targetBranch !== undefined
            ? { base: changes.targetBranch }
            : {}),
          ...draftTitleUpdate(current, changes, 'WIP'),
          ...(changes.body !== undefined ? { body: changes.body } : {}),
        }),
      );
    }
    case 'bitbucket': {
      const { apiBaseUrl, authHeader, workspace, repo } =
        await resolveBitbucketProviderContext(repository, 'write');
      return httpUpdates(
        buildApiUrl(
          apiBaseUrl,
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${prNumber}`,
          {},
        ),
        { name: 'Authorization', value: authHeader },
        'PUT',
        bitbucketPullRequestSchema,
        (data) => ({
          open: data.state === 'OPEN',
          headSha: data.source?.commit?.hash,
          draft: data.draft,
        }),
        (_current, changes) => ({
          ...(changes.targetBranch !== undefined
            ? { destination: { branch: { name: changes.targetBranch } } }
            : {}),
          ...(changes.title !== undefined ? { title: changes.title } : {}),
          ...(changes.body !== undefined ? { description: changes.body } : {}),
          ...(changes.draft !== undefined ? { draft: changes.draft } : {}),
        }),
      );
    }
    case 'ado': {
      const { organizationApiBaseUrl, repositoryPullRequestsPath, token } =
        await resolveAdoProviderContext(repository, 'write');
      return httpUpdates(
        buildApiUrl(
          organizationApiBaseUrl,
          `${repositoryPullRequestsPath}/${prNumber}`,
          { 'api-version': '7.1' },
        ),
        { name: 'Authorization', value: buildAdoBasicAuthHeader(token) },
        'PATCH',
        adoPullRequestSchema,
        (data) => ({
          open: data.status === 'active',
          headSha: data.lastMergeSourceCommit?.commitId,
          draft: data.isDraft,
        }),
        (_current, changes) => ({
          ...(changes.targetBranch !== undefined
            ? { targetRefName: normalizeAdoBranchRef(changes.targetBranch) }
            : {}),
          ...(changes.title !== undefined ? { title: changes.title } : {}),
          ...(changes.body !== undefined ? { description: changes.body } : {}),
          ...(changes.draft !== undefined ? { isDraft: changes.draft } : {}),
        }),
      );
    }
  }
}

function draftTitleUpdate(
  current: ProviderPullRequestState | undefined,
  changes: PullRequestChanges,
  prefix: 'Draft' | 'WIP',
) {
  const title = changes.title ?? current?.title ?? '';
  if (changes.draft === undefined)
    return changes.title === undefined ? {} : { title };
  return {
    title: changes.draft
      ? isDraftTitle(title)
        ? title
        : `${prefix}: ${title}`
      : removeDraftTitlePrefix(title) || title,
  };
}

export function removeDraftTitlePrefix(title: string): string {
  return title.replace(/^(draft|wip):\s*/i, '').trim();
}

export function assertProviderDraftState(
  state: ProviderPullRequestState,
  draft: boolean,
  message: string,
) {
  if (state.draft !== draft) throw new Error(message);
}

export function explicitDraftUpdateWarning(
  provider: SourceControlProvider,
  current: ProviderPullRequestState,
  changes: PullRequestChanges,
): string | undefined {
  if (changes.draft === undefined) return;
  if (provider === 'gitea') {
    if (!current.title && changes.title === undefined) {
      return 'Gitea did not expose the current title required for its Draft/WIP title transition, so none of the requested pull request updates were applied.';
    }
    if (changes.draft === false && current.nativeDraft === true) {
      return 'Gitea cannot change native draft state through this source-control interface, so none of the requested pull request updates were applied.';
    }
  }
  if (
    (provider === 'ado' || provider === 'bitbucket') &&
    typeof current.draft !== 'boolean'
  ) {
    return `${provider === 'ado' ? 'Azure DevOps' : 'Bitbucket Cloud'} did not expose draft state, so none of the requested pull request updates were applied.`;
  }
}
