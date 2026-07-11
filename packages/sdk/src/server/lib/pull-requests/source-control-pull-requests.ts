import { createGitHubToken } from '@roomote/auth';
import {
  buildAdoOrganizationApiBaseUrl,
  resolveAdoBaseUrl,
  resolveAdoToken,
} from '@roomote/ado';
import {
  buildBitbucketApiBaseUrl,
  resolveBitbucketBaseUrl,
  resolveBitbucketToken,
  resolveBitbucketUsername,
} from '@roomote/bitbucket';
import {
  buildGiteaApiBaseUrl,
  resolveGiteaBaseUrl,
  resolveGiteaToken,
} from '@roomote/gitea';
import {
  getOctokit,
  resolveConfiguredGitHubAppSlugIfConfigured,
} from '@roomote/github';
import {
  buildGitLabApiBaseUrl,
  resolveGitLabBaseUrl,
  resolveGitLabToken,
} from '@roomote/gitlab';
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
  resolveSourceControlProviderFromPayload,
  sourceControlProviderSchema,
  type PrAction,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
  assertRepositoryInTaskRunScope,
  buildAdoBasicAuthHeader,
  buildApiUrl,
  formatResponseBody,
  getPayloadRecord,
  isDraftTitle,
  isGitLabDraft,
  parseAdoRepositoryFullName,
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
};

const gitLabMergeRequestSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
  web_url: z.string().url().optional(),
  target_branch: z.string().optional(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
});
const gitLabMergeRequestListSchema = z.array(gitLabMergeRequestSchema);

const giteaPullRequestSchema = z
  .object({
    number: z.number().int().optional(),
    index: z.number().int().optional(),
    title: z.string().optional(),
    html_url: z.string().url().optional(),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string().optional() }).optional(),
    base: z.object({ ref: z.string().optional() }).optional(),
  })
  .passthrough();
const giteaPullRequestListSchema = z.array(giteaPullRequestSchema);

const bitbucketPullRequestSchema = z
  .object({
    id: z.number().int(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    links: z
      .object({
        html: z.object({ href: z.string().url().optional() }).optional(),
      })
      .optional(),
    source: z
      .object({
        branch: z.object({ name: z.string().optional() }).optional(),
      })
      .optional(),
    destination: z
      .object({
        branch: z.object({ name: z.string().optional() }).optional(),
      })
      .optional(),
  })
  .passthrough();
const bitbucketPullRequestListSchema = z.object({
  values: z.array(bitbucketPullRequestSchema),
  next: z.string().url().optional().nullable(),
});

const adoPullRequestSchema = z
  .object({
    pullRequestId: z.number().int(),
    title: z.string(),
    isDraft: z.boolean().optional(),
    targetRefName: z.string().optional(),
  })
  .passthrough();
const adoPullRequestListSchema = z.object({
  value: z.array(adoPullRequestSchema),
});

export async function createOrUpdateSourceControlPullRequestForTaskRun({
  taskRun,
  input,
  fetchImpl = fetch,
}: {
  taskRun: TaskRun;
  input: SourceControlPullRequestMutationInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const payloadProvider = resolveSourceControlProviderFromPayload(
    getPayloadRecord(taskRun.payload),
  );
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

  const result = await (() => {
    switch (provider) {
      case 'github':
        return createOrUpdateGitHubPullRequest({
          input: inputWithNormalizedAttribution,
          repository,
          provider,
          createDraft,
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
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'github';
  createDraft: boolean;
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
      body: input.body,
    });
    pullRequest = data;
  } else {
    action = 'created';
    targetBranch = requireTargetBranchForCreate(input);
    const { data } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: input.title,
      body: input.body,
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
  if (!repository.externalRepoId) {
    throw new Error(
      `GitLab repository ${repository.fullName} is missing an external project id.`,
    );
  }

  const token = await resolveGitLabToken();
  if (!token) {
    throw new Error(
      'GITLAB_TOKEN is required to create GitLab merge requests.',
    );
  }

  const baseUrl = await resolveGitLabBaseUrl();
  const apiBaseUrl = buildGitLabApiBaseUrl(baseUrl);
  const host = new URL(baseUrl).host;
  const existingMergeRequests = await listGitLabMergeRequests({
    apiBaseUrl,
    projectId: repository.externalRepoId,
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
            repository.externalRepoId,
          )}/merge_requests/${existing.iid}`,
          {},
        ),
        tokenHeader: { name: 'PRIVATE-TOKEN', value: token },
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
          `/projects/${encodeURIComponent(
            repository.externalRepoId,
          )}/merge_requests`,
          {},
        ),
        tokenHeader: { name: 'PRIVATE-TOKEN', value: token },
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

async function listGitLabMergeRequests({
  apiBaseUrl,
  projectId,
  input,
  token,
  fetchImpl,
}: {
  apiBaseUrl: string;
  projectId: string;
  input: SourceControlPullRequestMutationInput;
  token: string;
  fetchImpl: FetchImpl;
}) {
  return requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/projects/${encodeURIComponent(projectId)}/merge_requests`,
      {
        state: 'opened',
        source_branch: input.sourceBranch,
        ...(input.targetBranch ? { target_branch: input.targetBranch } : {}),
        per_page: 2,
      },
    ),
    tokenHeader: { name: 'PRIVATE-TOKEN', value: token },
    schema: gitLabMergeRequestListSchema,
  });
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
  const token = await resolveGiteaToken();
  if (!token) {
    throw new Error('GITEA_TOKEN is required to create Gitea pull requests.');
  }

  const baseUrl = await resolveGiteaBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'GITEA_BASE_URL is required to create Gitea pull requests.',
    );
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, provider);
  const apiBaseUrl = buildGiteaApiBaseUrl(baseUrl);
  const existingPullRequests = await listGiteaPullRequests({
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
  const token = await resolveBitbucketToken();
  if (!token) {
    throw new Error(
      'BITBUCKET_TOKEN is required to create Bitbucket pull requests.',
    );
  }

  const username = await resolveBitbucketUsername();
  if (!username) {
    throw new Error(
      'BITBUCKET_USERNAME is required to create Bitbucket pull requests.',
    );
  }

  const baseUrl = await resolveBitbucketBaseUrl();
  const [workspace, repo] = splitRepositoryFullName(
    repository.fullName,
    provider,
  );
  const apiBaseUrl = buildBitbucketApiBaseUrl(baseUrl);
  const tokenHeader = {
    name: 'Authorization',
    value: `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`,
  };
  const existingPullRequests = await listBitbucketPullRequests({
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

async function listBitbucketPullRequests({
  apiBaseUrl,
  workspace,
  repo,
  input,
  tokenHeader,
  fetchImpl,
}: {
  apiBaseUrl: string;
  workspace: string;
  repo: string;
  input: SourceControlPullRequestMutationInput;
  tokenHeader: { name: string; value: string };
  fetchImpl: FetchImpl;
}) {
  const matches: z.infer<typeof bitbucketPullRequestSchema>[] = [];
  const enoughMatches = input.targetBranch ? 1 : 2;
  let nextUrl: string | null = buildApiUrl(
    apiBaseUrl,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/pullrequests`,
    { state: 'OPEN', pagelen: 50 },
  );

  while (nextUrl && matches.length < enoughMatches) {
    const page: z.infer<typeof bitbucketPullRequestListSchema> =
      await requestJson({
        fetchImpl,
        url: nextUrl,
        tokenHeader,
        schema: bitbucketPullRequestListSchema,
      });

    matches.push(
      ...page.values.filter(
        (pullRequest: z.infer<typeof bitbucketPullRequestSchema>) =>
          pullRequest.source?.branch?.name === input.sourceBranch &&
          (!input.targetBranch ||
            pullRequest.destination?.branch?.name === input.targetBranch),
      ),
    );

    nextUrl = page.next ?? null;
  }

  return matches;
}

const GITEA_PULLS_PAGE_SIZE = 50;
const GITEA_PULLS_MAX_PAGES = 40;

/**
 * Gitea's pulls listing has no head/base filter, so matching happens
 * client-side and must walk pages: stopping at the first page could
 * falsely conclude no pull request exists for the source branch. The walk
 * ends as soon as the caller has what it needs — one match when the target
 * branch pins a unique head+base pair, two when an omitted targetBranch
 * only needs enough to prove ambiguity.
 */
async function listGiteaPullRequests({
  apiBaseUrl,
  owner,
  repo,
  input,
  token,
  fetchImpl,
}: {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  input: SourceControlPullRequestMutationInput;
  token: string;
  fetchImpl: FetchImpl;
}) {
  const matches: z.infer<typeof giteaPullRequestSchema>[] = [];
  const enoughMatches = input.targetBranch ? 1 : 2;

  for (let page = 1; page <= GITEA_PULLS_MAX_PAGES; page++) {
    const pullRequests = await requestJson({
      fetchImpl,
      url: buildApiUrl(
        apiBaseUrl,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        { state: 'open', limit: GITEA_PULLS_PAGE_SIZE, page },
      ),
      tokenHeader: { name: 'Authorization', value: `token ${token}` },
      schema: giteaPullRequestListSchema,
    });

    matches.push(
      ...pullRequests.filter(
        (pullRequest) =>
          pullRequest.head?.ref === input.sourceBranch &&
          (!input.targetBranch || pullRequest.base?.ref === input.targetBranch),
      ),
    );

    if (
      matches.length >= enoughMatches ||
      pullRequests.length < GITEA_PULLS_PAGE_SIZE
    ) {
      break;
    }
  }

  return matches;
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
  if (!repository.externalRepoId) {
    throw new Error(
      `Azure DevOps repository ${repository.fullName} is missing an external repository id.`,
    );
  }

  const token = await resolveAdoToken();
  if (!token) {
    throw new Error(
      'ADO_TOKEN is required to create Azure DevOps pull requests.',
    );
  }

  const { organization, project } = parseAdoRepositoryFullName(
    repository.fullName,
  );
  const baseUrl = await resolveAdoBaseUrl();
  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl,
    organization,
  });
  const repositoryPullRequestsPath = `/${encodeURIComponent(
    project,
  )}/_apis/git/repositories/${encodeURIComponent(
    repository.externalRepoId,
  )}/pullrequests`;
  const existingPullRequests = await listAdoPullRequests({
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

async function listAdoPullRequests({
  organizationApiBaseUrl,
  repositoryPullRequestsPath,
  input,
  token,
  fetchImpl,
}: {
  organizationApiBaseUrl: string;
  repositoryPullRequestsPath: string;
  input: SourceControlPullRequestMutationInput;
  token: string;
  fetchImpl: FetchImpl;
}) {
  const result = await requestJson({
    fetchImpl,
    url: buildApiUrl(organizationApiBaseUrl, repositoryPullRequestsPath, {
      'api-version': ADO_API_VERSION,
      'searchCriteria.status': 'active',
      'searchCriteria.sourceRefName': normalizeAdoBranchRef(input.sourceBranch),
      ...(input.targetBranch
        ? {
            'searchCriteria.targetRefName': normalizeAdoBranchRef(
              input.targetBranch,
            ),
          }
        : {}),
      $top: 2,
    }),
    tokenHeader: {
      name: 'Authorization',
      value: buildAdoBasicAuthHeader(token),
    },
    schema: adoPullRequestListSchema,
  });

  return result.value;
}

async function requestJson<T>({
  fetchImpl,
  method = 'GET',
  url,
  tokenHeader,
  body,
  schema,
}: {
  fetchImpl: FetchImpl;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  tokenHeader: { name: string; value: string };
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<T> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/json',
      [tokenHeader.name]: tokenHeader.value,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (![200, 201].includes(response.status)) {
    throw new Error(
      `Source control API request failed: ${response.status} ${
        response.statusText
      }${await formatResponseBody(response)}`,
    );
  }

  return schema.parse(await response.json());
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

function normalizeAdoBranchRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

function stripAdoBranchRef(ref: string | undefined): string | undefined {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
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
