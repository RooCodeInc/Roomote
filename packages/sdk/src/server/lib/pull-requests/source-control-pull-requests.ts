import { createGitHubToken } from '@roomote/auth';
import {
  buildAdoOrganizationApiBaseUrl,
  resolveAdoBaseUrl,
  resolveAdoToken,
} from '@roomote/ado';
import {
  buildGiteaApiBaseUrl,
  resolveGiteaBaseUrl,
  resolveGiteaToken,
} from '@roomote/gitea';
import { getOctokit } from '@roomote/github';
import {
  buildGitLabApiBaseUrl,
  resolveGitLabBaseUrl,
  resolveGitLabToken,
} from '@roomote/gitlab';
import {
  db,
  eq,
  cloudJobs,
  getDeploymentPrAction,
  sql,
  taskPullRequests,
  type CloudJob,
} from '@roomote/db/server';
import {
  buildPullRequestUrl,
  getSourceControlProviderLabel,
  prActions,
  resolveSourceControlProviderFromPayload,
  sourceControlProviderSchema,
  type PrAction,
  type SourceControlProvider,
} from '@roomote/types';
import { z } from 'zod';
import {
  assertRepositoryInCloudJobScope,
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
  targetBranch: z.string().trim().min(1),
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

type GitHubPullRequestResult = {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  draft?: boolean;
};

const gitLabMergeRequestSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
  web_url: z.string().url().optional(),
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

const adoPullRequestSchema = z
  .object({
    pullRequestId: z.number().int(),
    title: z.string(),
    isDraft: z.boolean().optional(),
  })
  .passthrough();
const adoPullRequestListSchema = z.object({
  value: z.array(adoPullRequestSchema),
});

export async function createOrUpdateSourceControlPullRequestForCloudJob({
  cloudJob,
  input,
  fetchImpl = fetch,
}: {
  cloudJob: CloudJob;
  input: SourceControlPullRequestMutationInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlPullRequestMutationResult> {
  const payloadProvider = resolveSourceControlProviderFromPayload(
    getPayloadRecord(cloudJob.payload),
  );
  const provider = input.sourceControlProvider ?? payloadProvider;

  if (provider !== payloadProvider) {
    throw new Error(
      `Source control provider mismatch: task uses ${getSourceControlProviderLabel(
        payloadProvider,
      )}, but request specified ${getSourceControlProviderLabel(provider)}.`,
    );
  }

  await assertRepositoryInCloudJobScope(cloudJob, input.repositoryFullName);

  const repository = await resolveRepositoryRow({
    provider,
    repositoryFullName: input.repositoryFullName,
  });

  const prAction = await resolveEffectivePrAction(cloudJob);
  const createDraft = prAction !== 'create';

  const result = await (() => {
    switch (provider) {
      case 'github':
        return createOrUpdateGitHubPullRequest({
          input,
          repository,
          provider,
          createDraft,
        });
      case 'gitlab':
        return createOrUpdateGitLabMergeRequest({
          input,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
      case 'gitea':
        return createOrUpdateGiteaPullRequest({
          input,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
      case 'ado':
        return createOrUpdateAdoPullRequest({
          input,
          repository,
          provider,
          createDraft,
          fetchImpl,
        });
    }
  })();

  await persistSourceControlPullRequestAssociation({
    cloudJob,
    input,
    result,
    repository,
  });

  return result;
}

/**
 * Draft state is deployment policy, not agent choice. The effective PR
 * delivery action comes from the cloud job payload when a launch stamped one
 * (per-task override), falling back to the deployment-wide Source Control
 * setting. Only `prAction === 'create'` opens ready-for-review pull
 * requests; `draft` and `push` both open drafts when a pull request is
 * created at all. Updates never change an existing pull request's draft
 * state.
 */
async function resolveEffectivePrAction(cloudJob: CloudJob): Promise<PrAction> {
  const payloadPrAction = getPayloadRecord(cloudJob.payload).prAction;

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
  cloudJob,
  input,
  result,
  repository,
}: {
  cloudJob: CloudJob;
  input: SourceControlPullRequestMutationInput;
  result: SourceControlPullRequestMutationResult;
  repository: RepositoryRow;
}): Promise<void> {
  if (!cloudJob.taskId) {
    return;
  }

  const status = result.draft ? 'draft' : 'open';

  try {
    await db
      .insert(taskPullRequests)
      .values({
        taskId: cloudJob.taskId,
        sourceControlProvider: repository.sourceControlProvider,
        host: repository.host,
        repositoryId: repository.id,
        prUrl: result.url,
        prNumber: result.number,
        prTitle: result.title,
        repository: result.repositoryFullName,
        status,
      })
      .onConflictDoUpdate({
        target: [taskPullRequests.taskId, taskPullRequests.prUrl],
        set: {
          sourceControlProvider: repository.sourceControlProvider,
          host: repository.host,
          repositoryId: repository.id,
          prTitle: result.title,
          status,
          updatedAt: new Date(),
        },
      });

    // Mirror extract-pull-requests: the base SHA is only kept when the row
    // already pointed at this PR, so a concurrent association with a different
    // PR cannot leave a stale base stranded under this PR's repo/number.
    const rowStillPointsAtThisPr = sql`${cloudJobs.prRepo} = ${result.repositoryFullName} AND ${cloudJobs.prNumber} = ${result.number}`;

    await db
      .update(cloudJobs)
      .set({
        prSourceControlProvider: repository.sourceControlProvider,
        prRepo: result.repositoryFullName,
        prNumber: result.number,
        prBaseRef: input.targetBranch,
        prBaseSha: sql`CASE WHEN ${rowStillPointsAtThisPr} THEN ${cloudJobs.prBaseSha} ELSE NULL END`,
      })
      .where(eq(cloudJobs.id, cloudJob.id));
  } catch (error) {
    console.warn(
      `[persistSourceControlPullRequestAssociation] Failed to associate ${result.repositoryFullName}#${result.number} with task ${cloudJob.taskId}: ${
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
    base: input.targetBranch,
    per_page: 1,
  });

  let action: SourceControlPullRequestMutationResult['action'];
  let pullRequest: GitHubPullRequestResult | undefined =
    existingPullRequests[0];

  if (pullRequest) {
    action = 'updated';
    const { data } = await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pullRequest.number,
      title: input.title,
      body: input.body,
      base: input.targetBranch,
    });
    pullRequest = data;
  } else {
    action = 'created';
    const { data } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: input.title,
      body: input.body,
      head: input.sourceBranch,
      base: input.targetBranch,
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
  const existing = await listGitLabMergeRequest({
    apiBaseUrl,
    projectId: repository.externalRepoId,
    input,
    token,
    fetchImpl,
  });
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
          target_branch: input.targetBranch,
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
    draft: isGitLabDraft(mergeRequest),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

async function listGitLabMergeRequest({
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
  const mergeRequests = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/projects/${encodeURIComponent(projectId)}/merge_requests`,
      {
        state: 'opened',
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        per_page: 1,
      },
    ),
    tokenHeader: { name: 'PRIVATE-TOKEN', value: token },
    schema: gitLabMergeRequestListSchema,
  });

  return mergeRequests[0];
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
  const existing = await listGiteaPullRequest({
    apiBaseUrl,
    owner,
    repo,
    input,
    token,
    fetchImpl,
  });
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
          base: input.targetBranch,
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
    draft: Boolean(pullRequest.draft) || isDraftTitle(pullRequest.title),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

async function listGiteaPullRequest({
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
  const pullRequests = await requestJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      { state: 'open', limit: 50 },
    ),
    tokenHeader: { name: 'Authorization', value: `token ${token}` },
    schema: giteaPullRequestListSchema,
  });

  return pullRequests.find(
    (pullRequest) =>
      pullRequest.head?.ref === input.sourceBranch &&
      pullRequest.base?.ref === input.targetBranch,
  );
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
  const existing = await listAdoPullRequest({
    organizationApiBaseUrl,
    repositoryPullRequestsPath,
    input,
    token,
    fetchImpl,
  });
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
          targetRefName: normalizeAdoBranchRef(input.targetBranch),
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
    draft: Boolean(pullRequest.isDraft),
    warnings: buildUnsupportedWarnings(input, provider),
  };
}

async function listAdoPullRequest({
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
      'searchCriteria.targetRefName': normalizeAdoBranchRef(input.targetBranch),
      $top: 1,
    }),
    tokenHeader: {
      name: 'Authorization',
      value: buildAdoBasicAuthHeader(token),
    },
    schema: adoPullRequestListSchema,
  });

  return result.value[0];
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

  if (provider === 'gitea' && input.labels.length > 0) {
    warnings.push(
      'Gitea label assignment is not supported by the provider-neutral pull request tool yet.',
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

export async function findCloudJobForSourceControlMutation({
  cloudJobId,
  taskId,
}: {
  cloudJobId: number;
  taskId: string;
}): Promise<CloudJob> {
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
  });

  if (!cloudJob) {
    throw new SourceControlMutationError(
      404,
      'Cloud job not found for this MCP token.',
    );
  }

  if (cloudJob.taskId !== taskId) {
    throw new SourceControlMutationError(
      403,
      'Cloud job token does not match the requested task.',
    );
  }

  return cloudJob;
}
