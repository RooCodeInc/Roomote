import { createGitHubToken } from '@roomote/auth';
import {
  DEFAULT_ROOMOTE_COMMIT_AUTHOR,
  getPrBodyAttributionLine,
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
  getDeploymentGitHubRoomoteMentionEnabled,
  resolveTelegramRuntimeCredentials,
  tasks,
  taskRuns,
  getDeploymentPrAction,
  projectPendingPrReviewEventsForAssociation,
  taskPullRequests,
  type TaskRun,
} from '@roomote/db/server';
import {
  buildPullRequestUrl,
  getSourceControlProviderLabel,
  findPrBodyAttributionLine,
  preservePrBodyAttribution,
  getCommunicationProviderFromTaskPayload,
  getCommunicationGuildIdFromTaskPayload,
  getCommunicationTenantIdFromTaskPayload,
  getCommunicationChannelFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getSlackChannelFromTaskPayload,
  getSlackTeamIdFromTaskPayload,
  getSlackTeamDomainFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
  getSlackConversationUrlFromTaskPayload,
  prActions,
  sourceControlProviderSchema,
  type PrAction,
  type SourceControlProvider,
} from '@roomote/types';
import { Env } from '@roomote/env';
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
  resolveSourceControlHostForRepositoryFromPayload,
  resolveSourceControlProviderForRepositoryFromPayload,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';
import { notifyFastAgentParentOnPullRequestOpened } from '../task-runs/notify-fast-agent-parent-on-pull-request-opened';

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
  assignees?: Array<{ login?: string | null }> | null;
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
  const payloadProvider = resolveSourceControlProviderForRepositoryFromPayload(
    payloadRecord,
    input.repositoryFullName,
  );
  const payloadHost = resolveSourceControlHostForRepositoryFromPayload(
    payloadRecord,
    input.repositoryFullName,
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
    host: payloadHost,
  });

  const prAction = await resolveEffectivePrAction(taskRun);
  const createDraft = prAction !== 'create';

  // PR provenance mentions are injected into the agent prompt at task start.
  // Normalize them again at write time so setting changes and late app-slug
  // resolution are reflected in the final PR body.
  const [configuredGitHubAppSlug, roomoteMentionEnabled] = await Promise.all([
    resolveConfiguredGitHubAppSlugIfConfigured(),
    getDeploymentGitHubRoomoteMentionEnabled(),
  ]);
  const attribution = await resolveRunCommitAuthor(db, taskRun, {
    provider,
    host: repository.host ?? payloadHost,
  });
  const displayName =
    attribution.kind === 'roomote'
      ? null
      : repository.private === true
        ? attribution.displayName
        : attribution.publicDisplayName;
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskRun.taskId),
    columns: {
      surface: true,
      slackChannelId: true,
      slackThreadTs: true,
    },
  });
  const communicationProvider = getCommunicationProviderFromTaskPayload(
    taskRun.payload,
  );
  const telegramBotUsername =
    communicationProvider === 'telegram'
      ? (await resolveTelegramRuntimeCredentials()).botUsername
      : null;
  const canonicalAttribution = displayName
    ? { ...attribution, displayName }
    : DEFAULT_ROOMOTE_COMMIT_AUTHOR;
  const attributionLine = getPrBodyAttributionLine({
    attribution: canonicalAttribution,
    taskUrl: buildPrAttributionTaskUrl(taskRun),
    taskSurface:
      task?.surface === 'system' || task?.surface === 'api'
        ? 'web'
        : (task?.surface ?? communicationProvider ?? 'web'),
    slackTeamDomain:
      getSlackTeamDomainFromTaskPayload(taskRun.payload) ?? undefined,
    slackTeamId: getSlackTeamIdFromTaskPayload(taskRun.payload) ?? undefined,
    slackConversationUrl:
      getSlackConversationUrlFromTaskPayload(taskRun.payload) ?? undefined,
    slackChannel:
      getSlackChannelFromTaskPayload(taskRun.payload) ??
      task?.slackChannelId ??
      undefined,
    slackThreadTs:
      getSlackThreadTsFromTaskPayload(taskRun.payload) ??
      task?.slackThreadTs ??
      undefined,
    telegramChatId:
      communicationProvider === 'telegram'
        ? (getCommunicationChannelFromTaskPayload(taskRun.payload) ?? undefined)
        : undefined,
    telegramThreadId:
      communicationProvider === 'telegram'
        ? (getCommunicationThreadIdFromTaskPayload(taskRun.payload) ??
          undefined)
        : undefined,
    telegramMessageId:
      communicationProvider === 'telegram'
        ? (getCommunicationMessageIdFromTaskPayload(taskRun.payload) ??
          undefined)
        : undefined,
    telegramBotUsername: telegramBotUsername ?? undefined,
    teamsConversationId:
      communicationProvider === 'teams'
        ? (getCommunicationChannelFromTaskPayload(taskRun.payload) ?? undefined)
        : undefined,
    teamsMessageId:
      communicationProvider === 'teams'
        ? (getCommunicationMessageIdFromTaskPayload(taskRun.payload) ??
          undefined)
        : undefined,
    teamsTenantId:
      getCommunicationTenantIdFromTaskPayload(taskRun.payload) ?? undefined,
    teamsBotAppId: Env.R_TEAMS_BOT_APP_ID,
    discordGuildId:
      getCommunicationGuildIdFromTaskPayload(taskRun.payload) ?? undefined,
    discordChannelId:
      communicationProvider === 'discord'
        ? (getCommunicationChannelFromTaskPayload(taskRun.payload) ?? undefined)
        : undefined,
    discordMessageId:
      communicationProvider === 'discord'
        ? (getCommunicationMessageIdFromTaskPayload(taskRun.payload) ??
          undefined)
        : undefined,
    githubAppSlug: configuredGitHubAppSlug,
    roomoteMentionEnabled,
  });
  const inputWithNormalizedAttribution: SourceControlPullRequestMutationInput =
    {
      ...input,
      body: attributionLine
        ? prependCanonicalPrAttribution(input.body, attributionLine)
        : input.body,
    };

  const liveGitHubAttribution = provider === 'github' ? attribution : undefined;
  const liveGitHubAssigneePlan = liveGitHubAttribution
    ? await resolveLiveGitHubAssigneePlan({
        taskRun,
        assignees: inputWithNormalizedAttribution.assignees,
        attribution: liveGitHubAttribution,
      })
    : undefined;
  const inputWithLiveGitHubAssignee = liveGitHubAssigneePlan
    ? {
        ...inputWithNormalizedAttribution,
        assignees: liveGitHubAssigneePlan.assignees,
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
          staleLaunchAssignee: liveGitHubAssigneePlan?.staleLaunchAssignee,
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

  // Finish the open event before returning to the child so a very fast
  // completion cannot overtake it in the parent conversation. Transient
  // failures propagate after releasing their claim: the next source-control
  // attempt finds this PR, updates it, and re-enters the deduplicated notifier.
  await notifyFastAgentParentOnPullRequestOpened({
    run: taskRun,
    ...(input.body.trim() ? { taskGeneratedContext: input.body.trim() } : {}),
    pullRequest: {
      provider: result.provider,
      host: repository.host,
      repository: result.repositoryFullName,
      number: result.number,
      title: result.title,
      url: result.url,
      status: result.draft ? 'draft' : 'open',
    },
  });

  return result;
}

async function resolveLiveGitHubAssigneePlan({
  taskRun,
  assignees,
  attribution,
}: {
  taskRun: TaskRun;
  assignees: string[];
  attribution: ResolvedTaskCommitAuthor;
}): Promise<{ assignees: string[]; staleLaunchAssignee?: string }> {
  // Delivery prompts may still contain the launch owner's assignee. Remove
  // that stale value, then add only the current linked participant.
  const launchAssignee = (
    await resolveLaunchTaskCommitAuthor(db, taskRun.taskId)
  ).prAssigneeLogin;
  const liveAssignees = assignees.filter(
    (assignee) => assignee !== launchAssignee,
  );

  return {
    assignees: attribution.prAssigneeLogin
      ? [...new Set([...liveAssignees, attribution.prAssigneeLogin])]
      : liveAssignees,
    ...(launchAssignee && launchAssignee !== attribution.prAssigneeLogin
      ? { staleLaunchAssignee: launchAssignee }
      : {}),
  };
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
 * association directly. The provider mutation is idempotent, so an
 * association failure must reject the operation and make the whole mutation
 * visibly retriable instead of reporting an unowned pull request as complete.
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

  await db.transaction(async (tx) => {
    await tx
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
    await projectPendingPrReviewEventsForAssociation(tx, {
      taskId: taskRun.taskId,
      sourceControlProvider: repository.sourceControlProvider,
      repository: result.repositoryFullName,
      prNumber: result.number,
    });
  });
}

async function createOrUpdateGitHubPullRequest({
  input,
  repository,
  provider,
  createDraft,
  staleLaunchAssignee,
}: {
  input: SourceControlPullRequestMutationInput;
  repository: RepositoryRow;
  provider: 'github';
  createDraft: boolean;
  staleLaunchAssignee?: string;
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
  const existingAssignees = pullRequest?.assignees ?? [];
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
      body: preservePrBodyAttribution(input.body, pullRequest.body ?? ''),
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

  if (
    action === 'updated' &&
    staleLaunchAssignee &&
    existingAssignees.some((assignee) => assignee.login === staleLaunchAssignee)
  ) {
    await octokit.rest.issues.removeAssignees({
      owner,
      repo,
      issue_number: pullRequest.number,
      assignees: [staleLaunchAssignee],
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

function buildPrAttributionTaskUrl(taskRun: TaskRun): string {
  const url = new URL(`/task/${taskRun.taskId}`, Env.R_APP_URL);
  url.searchParams.set('utm_source', 'github-comment');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', taskRun.payloadKind);
  return url.toString();
}

function prependCanonicalPrAttribution(body: string, line: string): string {
  const firstLineEnd = body.indexOf('\n');
  const firstLine = body.slice(
    0,
    firstLineEnd === -1 ? body.length : firstLineEnd,
  );
  const normalizedFirstLine = firstLine.trimStart();
  const hasLeadingAttribution =
    findPrBodyAttributionLine(firstLine) !== null ||
    /^> (?:Opened on behalf of .+\.|Created by Roomote\.) (?:Follow up by mentioning @|\[View the task\]\().+$/u.test(
      normalizedFirstLine,
    );
  const remainingBody = hasLeadingAttribution
    ? body
        .slice(firstLineEnd === -1 ? body.length : firstLineEnd + 1)
        .trimStart()
    : body.trimStart();

  return remainingBody ? `${line}\n\n${remainingBody}` : line;
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
