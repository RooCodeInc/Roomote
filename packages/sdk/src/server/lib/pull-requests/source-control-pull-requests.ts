import { createGitHubToken } from '@roomote/auth';
import {
  type ResolvedTaskCommitAuthor,
  resolveLaunchTaskCommitAuthor,
  resolveRunCommitAuthor,
} from '@roomote/cloud-agents/server';
import {
  getOctokit,
  resolveConfiguredGitHubAppSlugIfConfigured,
} from '@roomote/github';
import {
  db,
  eq,
  taskRuns,
  getDeploymentPrAction,
  taskPullRequests,
  type TaskRun,
} from '@roomote/db/server';
import {
  buildPullRequestUrl,
  getSourceControlProviderLabel,
  normalizePrBodyAttributionAppMention,
  prActions,
  resolveSourceControlHostFromPayload,
  resolveSourceControlProviderFromPayload,
  sourceControlProviderSchema,
  type PrAction,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
  adoPullRequestSchema,
  bitbucketPullRequestSchema,
  findOpenAdoPullRequestsByBranch,
  findOpenBitbucketPullRequestsByBranch,
  findOpenGiteaPullRequestsByBranch,
  findOpenGitLabMergeRequestsByBranch,
  giteaPullRequestSchema,
  gitLabMergeRequestSchema,
  normalizeAdoBranchRef,
  stripAdoBranchRef,
} from './source-control-pull-request-branch-lookup';
import { requestSourceControlJson as requestJson } from './source-control-pull-request-http';
import {
  resolveAdoProviderContext,
  resolveBitbucketProviderContext,
  resolveGiteaProviderContext,
  resolveGitLabProviderContext,
} from './source-control-pull-request-provider-context';
import {
  assertRepositoryInTaskRunScope,
  buildAdoBasicAuthHeader,
  buildApiUrl,
  buildGitLabTokenHeader,
  getPayloadRecord,
  isDraftTitle,
  isGitLabDraft,
  resolveRepositoryRow,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';

const ADO_API_VERSION = '7.1';

export const sourceControlPullRequestMutationInputSchema = z.object({
  action: z.literal('create_or_update_pull_request'),
  repositoryFullName: z.string().trim().min(1),
  sourceBranch: z.string().trim().min(1),
  // Optional so agents can refresh an existing pull request without
  // re-stating the base; creating a new pull request still requires it.
  targetBranch: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  body: z.string(),
  labels: z.array(z.string().trim().min(1)).default([]),
  assignees: z.array(z.string().trim().min(1)).default([]),
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type SourceControlPullRequestMutationInput = z.infer<
  typeof sourceControlPullRequestMutationInputSchema
>;

export type SourceControlPullRequestMutationResult = {
  success: true;
  action: 'created' | 'updated';
  provider: SourceControlProvider;
  repositoryFullName: string;
  number: number;
  url: string;
  title: string;
  /**
   * The effective base branch: the input targetBranch when given, otherwise
   * the existing pull request's base ref it defaulted to.
   */
  targetBranch: string;
  draft: boolean;
  warnings: string[];
};

export class SourceControlMutationError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'SourceControlMutationError';
  }
}

function requireTargetBranchForCreate(
  input: SourceControlPullRequestMutationInput,
): string {
  if (!input.targetBranch) {
    throw new SourceControlMutationError(
      400,
      `targetBranch is required to create a pull request: no open pull request was found for source branch "${input.sourceBranch}" in ${input.repositoryFullName}. Retry with targetBranch set (it is optional only when updating an existing open pull request).`,
    );
  }

  return input.targetBranch;
}

function resolveTargetBranchForUpdate(
  input: SourceControlPullRequestMutationInput,
  existingBaseRef: string | undefined,
): string {
  const targetBranch = input.targetBranch ?? existingBaseRef;

  if (!targetBranch) {
    throw new SourceControlMutationError(
      400,
      `Could not determine the base branch of the existing open pull request for source branch "${input.sourceBranch}" in ${input.repositoryFullName}. Retry with targetBranch set.`,
    );
  }

  return targetBranch;
}

/**
 * Without a targetBranch filter, "the existing pull request for this source
 * branch" is ambiguous when the branch has open pull requests against
 * multiple bases; refusing beats silently updating an arbitrary one.
 */
function assertUnambiguousExistingPullRequest(
  input: SourceControlPullRequestMutationInput,
  existingTargetRefs: Array<string | undefined>,
): void {
  if (input.targetBranch || existingTargetRefs.length <= 1) {
    return;
  }

  throw new SourceControlMutationError(
    409,
    `Multiple open pull requests exist for source branch "${input.sourceBranch}" in ${input.repositoryFullName} (target branches: ${existingTargetRefs
      .map((ref) => ref ?? 'unknown')
      .join(
        ', ',
      )}). Retry with targetBranch set to choose which one to update.`,
  );
}

type GitHubPullRequestResult = {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  draft?: boolean;
  base?: { ref: string };
  body?: string | null;
};

export async function createOrUpdateSourceControlPullRequestForTaskRun({
  taskRun,
  input,
  fetchImpl = fetch,
}: {
  taskRun: TaskRun;
  input: SourceControlPullRequestMutationInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const payloadRecord = getPayloadRecord(taskRun.payload);
  const payloadProvider =
    resolveSourceControlProviderFromPayload(payloadRecord);
  const payloadHost = resolveSourceControlHostFromPayload(payloadRecord);
  const provider = input.sourceControlProvider ?? payloadProvider;

  if (provider !== payloadProvider) {
    throw new Error(
      `Source control provider mismatch: task uses ${getSourceControlProviderLabel(
        payloadProvider,
      )}, but request specified ${getSourceControlProviderLabel(provider)}.`,
    );
  }

  await assertRepositoryInTaskRunScope(taskRun, input.repositoryFullName);

  const repository = await resolveRepositoryRow({
    provider,
    repositoryFullName: input.repositoryFullName,
    host: payloadHost,
  });

  const prAction = await resolveEffectivePrAction(taskRun);
  const createDraft = prAction !== 'create';

  // PR provenance mentions are injected into the agent prompt at task start
  // via `getPrBodyAttributionLine`. When slug resolution at prompt-build time
  // fell back to the schema default (`roomote`), the agent faithfully copies
  // `@roomote` into the body. Repair that only when this process has a real
  // configured slug — never rewrite with the default, or a correct custom
  // handle (e.g. `@roomote-roomote`) could be downgraded.
  const configuredGitHubAppSlug =
    await resolveConfiguredGitHubAppSlugIfConfigured();
  const inputWithNormalizedAttribution: SourceControlPullRequestMutationInput =
    configuredGitHubAppSlug
      ? {
          ...input,
          body: normalizePrBodyAttributionAppMention(
            input.body,
            configuredGitHubAppSlug,
          ),
        }
      : input;

  const liveGitHubAttribution =
    provider === 'github'
      ? await resolveRunCommitAuthor(db, taskRun)
      : undefined;
  const inputWithLiveGitHubAssignee = liveGitHubAttribution
    ? {
        ...inputWithNormalizedAttribution,
        assignees: await resolveLiveGitHubAssignees({
          taskRun,
          assignees: inputWithNormalizedAttribution.assignees,
          attribution: liveGitHubAttribution,
        }),
      }
    : inputWithNormalizedAttribution;

  const result = await (() => {
    switch (provider) {
      case 'github':
        return createOrUpdateGitHubPullRequest({
          input: inputWithLiveGitHubAssignee,
          repository,
          provider,
          createDraft,
          attribution: liveGitHubAttribution,
        });
      case 'gitlab':
        return createOrUpdateGitLabMergeRequest({
          input: inputWithNormalizedAttribution,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
      case 'gitea':
        return createOrUpdateGiteaPullRequest({
          input: inputWithNormalizedAttribution,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
      case 'bitbucket':
        return createOrUpdateBitbucketPullRequest({
          input: inputWithNormalizedAttribution,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
      case 'ado':
        return createOrUpdateAdoPullRequest({
          input: inputWithNormalizedAttribution,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
    }
  })();

  await persistSourceControlPullRequestAssociation({
    taskRun,
    result,
    repository,
  });

  return result;
}

async function resolveLiveGitHubAssignees({
  taskRun,
  assignees,
  attribution,
}: {
  taskRun: TaskRun;
  assignees: string[];
  attribution: ResolvedTaskCommitAuthor;
}): Promise<string[]> {
  // Delivery prompts may still contain the launch owner's assignee. Remove
  // that stale value, then add only the current linked participant.
  const launchAssignee = (
    await resolveLaunchTaskCommitAuthor(db, taskRun.taskId)
  ).prAssigneeLogin;
  const liveAssignees = assignees.filter(
    (assignee) => assignee !== launchAssignee,
  );

  return attribution.prAssigneeLogin
    ? [...new Set([...liveAssignees, attribution.prAssigneeLogin])]
    : liveAssignees;
}

/**
 * Draft state is deployment policy, not agent choice. The effective PR
 * delivery action comes from the task run payload when a launch stamped one
 * (per-task override), falling back to the deployment-wide Source Control
 * setting. Only `prAction === 'create'` opens ready-for-review pull
 * requests; `draft` and `push` both open drafts when a pull request is
 * created at all. Updates never change an existing pull request's draft
 * state.
 */
async function resolveEffectivePrAction(taskRun: TaskRun): Promise<PrAction> {
  const payloadPrAction = getPayloadRecord(taskRun.payload).prAction;

  if (prActions.includes(payloadPrAction as PrAction)) {
    return payloadPrAction as PrAction;
  }

  return getDeploymentPrAction();
}

/**
 * Record the task <-> pull request association at mutation time. The gh CLI
 * delivery path used to create this association by parsing `gh pr create`
 * tool output from the transcript; the server-side mutation path knows the
 * pull request authoritatively for every provider, so it persists the
 * association directly. Association failures must not fail the mutation the
 * agent already performed.
 */
async function persistSourceControlPullRequestAssociation({
  taskRun,
  result,
  repository,
}: {
  taskRun: TaskRun;
  result: SourceControlPullRequestMutationResult;
  repository: RepositoryRow;
}): Promise<void> {
  if (!taskRun.taskId) {
    return;
  }

  const status = result.draft ? 'draft' : 'open';

  try {
    await db
      .insert(taskPullRequests)
      .values({
        taskId: taskRun.taskId,
        sourceControlProvider: repository.sourceControlProvider,
        host: repository.host,
        repositoryId: repository.id,
        prUrl: result.url,
        prNumber: result.number,
        prTitle: result.title,
        repository: result.repositoryFullName,
        status,
        createdByRoomote: result.action === 'created',
        prBaseRef: result.targetBranch,
      })
      .onConflictDoUpdate({
        target: [taskPullRequests.taskId, taskPullRequests.prUrl],
        set: {
          sourceControlProvider: repository.sourceControlProvider,
          host: repository.host,
          repositoryId: repository.id,
          prTitle: result.title,
          status,
          prBaseRef: result.targetBranch,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.warn(
      `[persistSourceControlPullRequestAssociation] Failed to associate ${result.repositoryFullName}#${result.number} with task ${taskRun.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function createOrUpdateGitHubPullRequest({
  input,
  repository,
  provider,
  createDraft,
  attribution,
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'github';
  createDraft: boolean;
  attribution?: ResolvedTaskCommitAuthor;
}): Promise<SourceControlPullRequestMutationResult> {
  if (!repository.installationId) {
    throw new Error(
      `GitHub repository ${repository.fullName} is missing an installation id.`,
    );
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, provider);
  const token = await createGitHubToken({
    type: 'installationId',
    installationId: repository.installationId,
  });
  const octokit = getOctokit(token);

  const { data: existingPullRequests } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${input.sourceBranch}`,
    ...(input.targetBranch ? { base: input.targetBranch } : {}),
    per_page: 2,
  });

  assertUnambiguousExistingPullRequest(
    input,
    existingPullRequests.map((pullRequest) => pullRequest.base?.ref),
  );

  let action: SourceControlPullRequestMutationResult['action'];
  let pullRequest: GitHubPullRequestResult | undefined =
    existingPullRequests[0];
  let targetBranch: string;

  if (pullRequest) {
    action = 'updated';
    targetBranch = resolveTargetBranchForUpdate(input, pullRequest.base?.ref);
    // An update never sends base: an explicit targetBranch already scoped
    // the lookup to that base, and an omitted one means "keep the existing
    // base". Retargeting an open pull request is not something this tool
    // does; an explicit targetBranch with no matching pull request opens a
    // new one against that base instead.
    const { data } = await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pullRequest.number,
      title: input.title,
      body: preserveExistingPullRequestAttribution(
        input.body,
        pullRequest.body,
      ),
    });
    pullRequest = data;
  } else {
    action = 'created';
    targetBranch = requireTargetBranchForCreate(input);
    const { data } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: input.title,
      body: replaceCreatedPullRequestAttribution(input.body, attribution),
      head: input.sourceBranch,
      base: targetBranch,
      draft: createDraft,
    });
    pullRequest = data;
  }

  if (!pullRequest) {
    throw new Error('GitHub pull request response was empty.');
  }

  if (input.labels.length > 0) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: input.labels,
    });
  }

  if (input.assignees.length > 0) {
    await octokit.rest.issues.addAssignees({
      owner,
      repo,
      issue_number: pullRequest.number,
      assignees: input.assignees,
    });
  }

  return {
    success: true,
    action,
    provider,
    repositoryFullName: repository.fullName,
    number: pullRequest.number,
    url: pullRequest.html_url,
    title: pullRequest.title,
    targetBranch,
    draft: Boolean(pullRequest.draft),
    warnings: [],
  };
}

function replaceCreatedPullRequestAttribution(
  body: string,
  attribution: ResolvedTaskCommitAuthor | undefined,
): string {
  if (!attribution) {
    return body;
  }

  return body.replace(
    /^(> Opened on behalf of ).+?(\. (?:Follow up by|\[View the task\]))/mu,
    `$1${attribution.displayName}$2`,
  );
}

function preserveExistingPullRequestAttribution(
  body: string,
  existingBody: string | null | undefined,
): string {
  const openerLine = existingBody?.match(/^> Opened on behalf of .+$/mu)?.[0];
  return openerLine
    ? body.replace(/^> Opened on behalf of .+$/mu, openerLine)
    : body;
}

async function createOrUpdateGitLabMergeRequest({
  input,
  repository,
  provider,
  createDraft,
  fetchImpl,
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'gitlab';
  createDraft: boolean;
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const { projectId, token, apiBaseUrl } = await resolveGitLabProviderContext(
    repository,
    'create',
  );
  const host = new URL(apiBaseUrl).host;
  const existingMergeRequests = await findOpenGitLabMergeRequestsByBranch({
    apiBaseUrl,
    projectId,
    input,
    token,
    fetchImpl,
  });

  assertUnambiguousExistingPullRequest(
    input,
    existingMergeRequests.map((mergeRequest) => mergeRequest.target_branch),
  );

  const existing = existingMergeRequests[0];
  const targetBranch = existing
    ? resolveTargetBranchForUpdate(input, existing.target_branch)
    : requireTargetBranchForCreate(input);
  const title = applyDraftTitle(
    input.title,
    existing ? isGitLabDraft(existing) : createDraft,
    'gitlab',
  );
  const common = {
    title,
    description: input.body,
  };

  const mergeRequest = existing
    ? await requestJson({
        fetchImpl,
        method: 'PUT',
        url: buildApiUrl(
          apiBaseUrl,
          `/projects/${encodeURIComponent(
            projectId,
          )}/merge_requests/${existing.iid}`,
          {},
        ),
        tokenHeader: buildGitLabTokenHeader(token),
        body: {
          ...common,
          ...(input.labels.length > 0
            ? { add_labels: input.labels.join(',') }
            : {}),
        },
        schema: gitLabMergeRequestSchema,
      })
    : await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          apiBaseUrl,
          `/projects/${encodeURIComponent(projectId)}/merge_requests`,
          {},
        ),
        tokenHeader: buildGitLabTokenHeader(token),
        body: {
          source_branch: input.sourceBranch,
          target_branch: targetBranch,
          remove_source_branch: false,
          ...common,
          ...(input.labels.length > 0
            ? { labels: input.labels.join(',') }
            : {}),
        },
        schema: gitLabMergeRequestSchema,
      });

  return {
    success: true,
    action: existing ? 'updated' : 'created',
    provider,
    repositoryFullName: repository.fullName,
    number: mergeRequest.iid,
    url:
      mergeRequest.web_url ??
      buildPullRequestUrl({
        provider,
        host,
        repositoryFullName: repository.fullName,
        number: mergeRequest.iid,
      }),
    title: mergeRequest.title,
    targetBranch,
    draft: isGitLabDraft(mergeRequest),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

async function createOrUpdateGiteaPullRequest({
  input,
  repository,
  provider,
  createDraft,
  fetchImpl,
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'gitea';
  createDraft: boolean;
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const { apiBaseUrl, baseUrl, owner, repo, token } =
    await resolveGiteaProviderContext(repository, 'create');
  const existingPullRequests = await findOpenGiteaPullRequestsByBranch({
    apiBaseUrl,
    owner,
    repo,
    input,
    token,
    fetchImpl,
  });

  assertUnambiguousExistingPullRequest(
    input,
    existingPullRequests.map((pullRequest) => pullRequest.base?.ref),
  );

  const existing = existingPullRequests[0];
  const targetBranch = existing
    ? resolveTargetBranchForUpdate(input, existing.base?.ref)
    : requireTargetBranchForCreate(input);
  const title = applyDraftTitle(
    input.title,
    existing
      ? Boolean(existing.draft) || isDraftTitle(existing.title)
      : createDraft,
    'gitea',
  );
  const pullRequest = existing
    ? await requestJson({
        fetchImpl,
        method: 'PATCH',
        url: buildApiUrl(
          apiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
          )}/pulls/${getGiteaPullRequestNumber(existing)}`,
          {},
        ),
        tokenHeader: { name: 'Authorization', value: `token ${token}` },
        body: { title, body: input.body },
        schema: giteaPullRequestSchema,
      })
    : await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          apiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
          )}/pulls`,
          {},
        ),
        tokenHeader: { name: 'Authorization', value: `token ${token}` },
        body: {
          base: targetBranch,
          head: input.sourceBranch,
          title,
          body: input.body,
          ...(input.assignees.length > 0 ? { assignees: input.assignees } : {}),
        },
        schema: giteaPullRequestSchema,
      });

  const number = getGiteaPullRequestNumber(pullRequest);
  const host = new URL(baseUrl).host;

  return {
    success: true,
    action: existing ? 'updated' : 'created',
    provider,
    repositoryFullName: repository.fullName,
    number,
    url:
      pullRequest.html_url ??
      buildPullRequestUrl({
        provider,
        host,
        repositoryFullName: repository.fullName,
        number,
      }),
    title: pullRequest.title ?? title,
    targetBranch,
    draft: Boolean(pullRequest.draft) || isDraftTitle(pullRequest.title),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

async function createOrUpdateBitbucketPullRequest({
  input,
  repository,
  provider,
  createDraft,
  fetchImpl,
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'bitbucket';
  createDraft: boolean;
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const { apiBaseUrl, authHeader, baseUrl, workspace, repo } =
    await resolveBitbucketProviderContext(repository, 'create');
  const tokenHeader = {
    name: 'Authorization',
    value: authHeader,
  };
  const existingPullRequests = await findOpenBitbucketPullRequestsByBranch({
    apiBaseUrl,
    workspace,
    repo,
    input,
    tokenHeader,
    fetchImpl,
  });

  assertUnambiguousExistingPullRequest(
    input,
    existingPullRequests.map(
      (pullRequest) => pullRequest.destination?.branch?.name,
    ),
  );

  const existing = existingPullRequests[0];
  const targetBranch = existing
    ? resolveTargetBranchForUpdate(input, existing.destination?.branch?.name)
    : requireTargetBranchForCreate(input);

  const pullRequest = existing
    ? await requestJson({
        fetchImpl,
        method: 'PUT',
        url: buildApiUrl(
          apiBaseUrl,
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
            repo,
          )}/pullrequests/${existing.id}`,
          {},
        ),
        tokenHeader,
        body: {
          title: input.title,
          description: input.body,
        },
        schema: bitbucketPullRequestSchema,
      })
    : await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(
          apiBaseUrl,
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
            repo,
          )}/pullrequests`,
          {},
        ),
        tokenHeader,
        body: {
          title: input.title,
          description: input.body,
          source: { branch: { name: input.sourceBranch } },
          destination: { branch: { name: targetBranch } },
          draft: createDraft,
        },
        schema: bitbucketPullRequestSchema,
      });

  const number = pullRequest.id;
  const host = new URL(baseUrl).host;

  return {
    success: true,
    action: existing ? 'updated' : 'created',
    provider,
    repositoryFullName: repository.fullName,
    number,
    url:
      pullRequest.links?.html?.href ??
      buildPullRequestUrl({
        provider,
        host,
        repositoryFullName: repository.fullName,
        number,
      }),
    title: pullRequest.title ?? input.title,
    targetBranch,
    draft: Boolean(pullRequest.draft) || isDraftTitle(pullRequest.title),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

async function createOrUpdateAdoPullRequest({
  input,
  repository,
  provider,
  createDraft,
  fetchImpl,
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'ado';
  createDraft: boolean;
  fetchImpl: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const { baseUrl, organizationApiBaseUrl, repositoryPullRequestsPath, token } =
    await resolveAdoProviderContext(repository, 'create');
  const existingPullRequests = await findOpenAdoPullRequestsByBranch({
    organizationApiBaseUrl,
    repositoryPullRequestsPath,
    input,
    token,
    fetchImpl,
  });

  assertUnambiguousExistingPullRequest(
    input,
    existingPullRequests.map((pullRequest) =>
      stripAdoBranchRef(pullRequest.targetRefName),
    ),
  );

  const existing = existingPullRequests[0];
  const targetBranch = existing
    ? resolveTargetBranchForUpdate(
        input,
        stripAdoBranchRef(existing.targetRefName),
      )
    : requireTargetBranchForCreate(input);
  // PATCH omits isDraft so an update never changes the existing draft state.
  const common = {
    title: input.title,
    description: input.body,
    ...(input.labels.length > 0
      ? { labels: input.labels.map((name) => ({ name })) }
      : {}),
  };
  const pullRequest = existing
    ? await requestJson({
        fetchImpl,
        method: 'PATCH',
        url: buildApiUrl(
          organizationApiBaseUrl,
          `${repositoryPullRequestsPath}/${existing.pullRequestId}`,
          { 'api-version': ADO_API_VERSION },
        ),
        tokenHeader: {
          name: 'Authorization',
          value: buildAdoBasicAuthHeader(token),
        },
        body: common,
        schema: adoPullRequestSchema,
      })
    : await requestJson({
        fetchImpl,
        method: 'POST',
        url: buildApiUrl(organizationApiBaseUrl, repositoryPullRequestsPath, {
          'api-version': ADO_API_VERSION,
        }),
        tokenHeader: {
          name: 'Authorization',
          value: buildAdoBasicAuthHeader(token),
        },
        body: {
          sourceRefName: normalizeAdoBranchRef(input.sourceBranch),
          targetRefName: normalizeAdoBranchRef(targetBranch),
          isDraft: createDraft,
          ...common,
        },
        schema: adoPullRequestSchema,
      });

  const host = new URL(baseUrl).host;

  return {
    success: true,
    action: existing ? 'updated' : 'created',
    provider,
    repositoryFullName: repository.fullName,
    number: pullRequest.pullRequestId,
    url: buildPullRequestUrl({
      provider,
      host,
      repositoryFullName: repository.fullName,
      number: pullRequest.pullRequestId,
    }),
    title: pullRequest.title,
    targetBranch,
    draft: Boolean(pullRequest.isDraft),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

function getGiteaPullRequestNumber(
  pullRequest: z.infer<typeof giteaPullRequestSchema>,
): number {
  const number = pullRequest.number ?? pullRequest.index;

  if (number === undefined || !Number.isInteger(number)) {
    throw new Error('Gitea pull request response did not include a number.');
  }

  return number;
}

function applyDraftTitle(
  title: string,
  draft: boolean,
  provider: 'gitlab' | 'gitea',
): string {
  if (!draft) {
    const stripped = title.replace(/^(draft|wip):\s*/i, '').trim();
    return stripped.length > 0 ? stripped : title;
  }

  if (isDraftTitle(title)) {
    return title;
  }

  return provider === 'gitlab' ? `Draft: ${title}` : `WIP: ${title}`;
}

function buildUnsupportedWarnings(
  input: SourceControlPullRequestMutationInput,
  provider: SourceControlProvider,
): string[] {
  const warnings: string[] = [];

  if (
    (provider === 'gitea' || provider === 'bitbucket') &&
    input.labels.length > 0
  ) {
    warnings.push(
      `${getSourceControlProviderLabel(
        provider,
      )} label assignment is not supported by the provider-neutral pull request tool yet.`,
    );
  }

  if (
    provider !== 'github' &&
    provider !== 'gitea' &&
    input.assignees.length > 0
  ) {
    warnings.push(
      `${getSourceControlProviderLabel(
        provider,
      )} assignee assignment requires provider-specific identity IDs and was not applied.`,
    );
  }

  return warnings;
}

export async function findTaskRunForSourceControlMutation({
  runId,
  taskId,
}: {
  runId: number;
  taskId: string;
}): Promise<TaskRun> {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    throw new SourceControlMutationError(
      404,
      'Task run not found for this MCP token.',
    );
  }

  if (taskRun.taskId !== taskId) {
    throw new SourceControlMutationError(
      403,
      'Task run token does not match the requested task.',
    );
  }

  return taskRun;
}
