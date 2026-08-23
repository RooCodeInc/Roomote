import { TRPCClientError } from '@trpc/client';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  notifyFastAgentParentOnPrFeedback,
  withSandboxServerRpcClient,
} from '@roomote/sdk/server';
import {
  and,
  db,
  eq,
  findReusableGitHubPrFollowUpOwner,
  getTaskGoalForRun,
  taskPullRequests,
  taskRuns,
  users,
} from '@roomote/db/server';
import type {
  AuthTokenContext,
  TaskPayload,
  RunTokenContext,
  PullRequestStatus,
  TaskGoal,
} from '@roomote/types';
import { trackLatestUserMessageForReplyQuote } from '@roomote/communication/messages';
import {
  TaskPayloadKind,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  getFastAgentParentFromPayload,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  isLinkedReviewResultsMessage,
  isExitedRunStatus,
  isSnapshotResumable,
  parseLinkedReviewResults,
  populateSnapshotResumeCommunicationMetadata,
  populateSnapshotResumeSlackMetadata,
  resolveSourceControlProviderFromPayload,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import {
  hasSlackThreadReplyContext,
  trackLatestUserMessageForSlackQuote,
} from '@roomote/slack';

import { findLatestTaskRun, getTaskChannelBindings } from './helpers';
import {
  restoreActingUserIdAfterFailedDelivery,
  updateActingUserIdIfNeeded,
} from './acting-user-sync';
import { logHandlerError } from '../utils';

const LINKED_REVIEW_HANDOFF_SOURCE = 'linked_review_handoff';
const SANDBOX_BOOTING_ERROR =
  "The task hasn't started yet — the sandbox is still booting. Try again in a few seconds.";
const REVIEW_HANDOFF_TASK_TYPES = new Set<TaskPayloadKind>([
  TaskPayloadKind.GithubPrReview,
  TaskPayloadKind.GithubPrReviewSync,
]);

type SendMessageErrorStatus = 404 | 409 | 500 | 502;
export type SendMessageSenderMode =
  | 'authenticated_user'
  | 'fast_agent'
  | 'linked_review_handoff'
  | 'github_pr_follow_up';

/**
 * Sender modes that must never overwrite the target task's actingUserId.
 * Automated / agent-to-agent relays belong here — the current actor may
 * hold elevated permissions (admin MCPs, write access) that should not
 * transfer to the automated sender.
 *
 * Only actor-preserving modes belong here. Some automated modes may still use
 * normal actor sync while opting out of Slack quote tracking separately.
 */
const ACTOR_PRESERVING_MODES = new Set<SendMessageSenderMode>([
  'linked_review_handoff',
]);

const SLACK_REPLY_QUOTE_SUPPRESSING_MODES = new Set<SendMessageSenderMode>([
  'fast_agent',
  'linked_review_handoff',
  'github_pr_follow_up',
]);

function shouldTrackReplyQuoteContext(
  senderMode?: SendMessageSenderMode,
): boolean {
  return !(senderMode && SLACK_REPLY_QUOTE_SUPPRESSING_MODES.has(senderMode));
}

function hasDiscordThreadReplyContext(payload: unknown): boolean {
  return (
    getCommunicationProviderFromTaskPayload(payload) === 'discord' &&
    Boolean(getCommunicationChannelFromTaskPayload(payload))
  );
}

function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveFollowUpPromptSource(options: {
  senderMode?: SendMessageSenderMode;
  source?: string;
}): string | undefined {
  if (options.senderMode === 'linked_review_handoff') {
    return LINKED_REVIEW_HANDOFF_SOURCE;
  }

  return normalizeOptionalString(options.source);
}

type SendMessageToTaskResult =
  | { success: true; result: unknown }
  | { success: false; error: string; status: SendMessageErrorStatus };

type LatestTaskRun = {
  id: number;
  status: string;
  sandboxServerUrl: string | null;
  actingUserId: string | null;
  snapshotId: string | null;
  snapshotCreatedAt: Date | null;
  sourceRunId: number | null;
  payload: Record<string, unknown> | null;
  port: number | null;
  result: unknown;
};

type LinkedReviewFastHandoff = {
  fastParentRequired: boolean;
  reviewRunId: number;
  reviewTaskId: string;
  reviewHeadSha?: string;
  pullRequest: {
    provider: 'github';
    host: string | null;
    repository: string;
    number: number;
    title: string | null;
    url: string;
    status: PullRequestStatus | null;
  };
  summary: string;
  suggestedActionQuestion?: string;
  suggestedActionPrompt?: string;
  reviewResult: {
    reviewKind: 'initial' | 'sync' | null;
    outcome: string | null;
    findingCount: number | null;
    approvalStatus: 'approved' | 'skipped' | null;
    headSha: string | null;
  };
};

type TaskChannelBindingsRow = {
  slackChannelId: string | null;
  slackThreadTs: string | null;
  linearSessionId: string | null;
  linearIssueId: string | null;
  linearOrganizationId: string | null;
};

const OPEN_LINKED_REVIEW_HANDOFF_STATUSES = new Set<PullRequestStatus>([
  'open',
  'draft',
]);

class SandboxNotReadyError extends Error {
  constructor() {
    super(SANDBOX_BOOTING_ERROR);
    this.name = 'SandboxNotReadyError';
  }
}

async function fetchSandboxRpcResponseOrThrowIfNotReady(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    signal,
  });

  if (response.status !== 200) {
    return response;
  }

  const body = await response.text();

  if (body === '') {
    throw new SandboxNotReadyError();
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function getTrackedUserDisplayName(
  userId: string,
): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      name: true,
      email: true,
    },
  });

  const name = user?.name?.trim();
  if (name) {
    return name;
  }

  const email = user?.email?.trim();
  if (email) {
    return email;
  }

  return userId;
}

/**
 * Resolve a display name for the worker-side Slack reply quote so routed
 * follow-up messages are attributed to the linked user instead of the
 * generic "Someone" fallback. Returns undefined when the name cannot be
 * resolved so the caller can omit the field entirely.
 *
 * Callers that already know the correct attribution (for example, the GitHub
 * PR follow-up handler, which can distinguish the commenter from the reusable
 * task owner) should pass an explicit `workerQuoteUserName` instead of
 * relying on this helper, since `userId` here may be the task owner rather
 * than the commenter when the commenter has no linked account.
 */
async function resolveWorkerQuoteUserName(
  senderMode: SendMessageSenderMode | undefined,
  userId: string,
): Promise<string | undefined> {
  if (senderMode !== 'github_pr_follow_up') {
    return undefined;
  }

  try {
    return await getTrackedUserDisplayName(userId);
  } catch {
    return undefined;
  }
}

async function createSlackReplyQuoteContext(params: {
  runId: number;
  payload: Record<string, unknown> | null;
  slackThreadTs: string | null;
  userId: string;
  message: string;
  userName?: string;
}): Promise<void> {
  if (!hasSlackThreadReplyContext(params)) {
    return;
  }

  const text = params.message.trim();
  if (!text) {
    return;
  }

  try {
    const userName =
      params.userName ?? (await getTrackedUserDisplayName(params.userId));

    await trackLatestUserMessageForSlackQuote({
      runId: params.runId,
      text,
      userName,
      onError: (error) => {
        logHandlerError(
          'sendMessageToTask',
          `Non-fatal latest user message sync failure for task run ${params.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    });
  } catch (error) {
    logHandlerError(
      'sendMessageToTask',
      `Non-fatal latest user message sync failure for task run ${params.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function createDiscordReplyQuoteContext(params: {
  runId: number;
  payload: Record<string, unknown> | null;
  userId: string;
  message: string;
  userName?: string;
}): Promise<void> {
  if (!hasDiscordThreadReplyContext(params.payload)) {
    return;
  }

  const text = params.message.trim();
  if (!text) {
    return;
  }

  try {
    const userName =
      params.userName ?? (await getTrackedUserDisplayName(params.userId));

    await trackLatestUserMessageForReplyQuote({
      provider: 'discord',
      runId: params.runId,
      text,
      userName,
      onError: (error) => {
        logHandlerError(
          'sendMessageToTask',
          `Non-fatal Discord reply quote sync failure for task run ${params.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    });
  } catch (error) {
    logHandlerError(
      'sendMessageToTask',
      `Non-fatal Discord reply quote sync failure for task run ${params.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getWrappedLinkedReviewTagValue(
  raw: string,
  tag: 'summary' | 'status_line',
): string | null {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1]?.trim() || null;
}

function hasLinkedReviewInnerTags(raw: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(raw);
}

function getLinkedReviewHandoffQuoteText(message: string): string | null {
  const parsed = parseLinkedReviewResults(message);

  if (!parsed) {
    return null;
  }

  const title = parsed.title?.trim();
  const summary =
    getWrappedLinkedReviewTagValue(parsed.raw, 'summary') ??
    getWrappedLinkedReviewTagValue(parsed.raw, 'status_line') ??
    (!hasLinkedReviewInnerTags(parsed.raw) ? parsed.summary.trim() : null) ??
    '';

  if (!title) {
    return summary || null;
  }

  if (!summary || summary === title) {
    return title;
  }

  return `${title}: ${summary}`;
}

async function createLinkedReviewHandoffQuoteContext(params: {
  runId: number;
  payload: Record<string, unknown> | null;
  slackThreadTs: string | null;
  message: string;
}): Promise<void> {
  const quoteText = getLinkedReviewHandoffQuoteText(params.message);

  if (!quoteText) {
    return;
  }

  await createSlackReplyQuoteContext({
    runId: params.runId,
    payload: params.payload,
    slackThreadTs: params.slackThreadTs,
    userId: 'linked-review-handoff',
    userName: 'Review',
    message: quoteText,
  });
  await createDiscordReplyQuoteContext({
    runId: params.runId,
    payload: params.payload,
    userId: 'linked-review-handoff',
    userName: 'Review',
    message: quoteText,
  });
}

async function maybeCreateSlackReplyQuoteContext(params: {
  runId: number;
  payload: Record<string, unknown> | null;
  slackThreadTs: string | null;
  userId: string;
  message: string;
  senderMode?: SendMessageSenderMode;
}): Promise<void> {
  if (params.senderMode === 'linked_review_handoff') {
    await createLinkedReviewHandoffQuoteContext(params);
    return;
  }

  if (!shouldTrackReplyQuoteContext(params.senderMode)) {
    return;
  }

  await createSlackReplyQuoteContext(params);
  await createDiscordReplyQuoteContext(params);
}

/**
 * Trusted actor switch, applied BEFORE the prompt reaches the sandbox.
 *
 * Ordering is load-bearing: the run's `actingUserId` selects whose
 * credentials actor-scoped routes resolve, and the worker refuses to run a
 * turn whose sender does not match the server-side acting user. Writing
 * after delivery (the previous design) opened a window where the new
 * sender's prompt ran while credential routes still resolved the previous
 * actor. Writing before delivery closes that window. If delivery fails, the
 * caller compare-and-set rolls the actor back so the previous in-flight turn
 * cannot continue resolving credentials as a sender whose prompt never ran.
 *
 * Errors propagate: proceeding with delivery after a failed required switch
 * would only bounce off the worker's mismatch guard with a less clear error.
 */
async function syncActingUserIdBeforeDelivery({
  runId,
  currentActingUserId,
  nextActingUserId,
  preserveActor,
}: {
  runId: number;
  currentActingUserId: string | null;
  nextActingUserId: string;
  preserveActor: boolean;
}): Promise<boolean> {
  return await updateActingUserIdIfNeeded({
    runId,
    currentActingUserId,
    nextActingUserId,
    preserveActor,
  });
}

async function inheritSnapshotResumeVisiblePromptFields(
  payload: Record<string, unknown>,
  sourcePayload: unknown,
  ancestorSourceRunId: number | null,
): Promise<void> {
  restoreSnapshotResumeVisiblePromptFields(payload, sourcePayload);

  const visited = new Set<number>();
  let currentSourceRunId = ancestorSourceRunId;

  while (currentSourceRunId && !visited.has(currentSourceRunId)) {
    visited.add(currentSourceRunId);

    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, currentSourceRunId),
      columns: {
        payload: true,
        sourceRunId: true,
      },
    });

    if (!sourceRun) {
      return;
    }

    restoreSnapshotResumeVisiblePromptFields(payload, sourceRun.payload);
    currentSourceRunId = sourceRun.sourceRunId;
  }
}

async function resumeTaskFromSnapshot({
  taskId,
  userId,
  message,
  quoteText,
  images,
  source,
  clientMessageId,
  sourceRun,
  channelBindings,
  senderMode,
}: {
  taskId: string;
  userId: string;
  message: string;
  quoteText: string;
  images?: string[];
  source?: string;
  clientMessageId?: string;
  sourceRun: LatestTaskRun;
  channelBindings: TaskChannelBindingsRow | null;
  senderMode?: SendMessageSenderMode;
}): Promise<SendMessageToTaskResult | null> {
  if (!sourceRun.snapshotId) {
    return null;
  }

  if (!isSnapshotResumable(sourceRun.snapshotCreatedAt)) {
    return {
      success: false,
      error: EXPIRED_SNAPSHOT_RESUME_ERROR,
      status: 409,
    };
  }

  const sourcePayload = sourceRun.payload ?? {};
  const repo =
    typeof sourcePayload.repo === 'string' ? sourcePayload.repo : undefined;
  const environmentId =
    typeof sourcePayload.environmentId === 'string'
      ? sourcePayload.environmentId
      : undefined;

  if (!repo && !environmentId) {
    return null;
  }

  const selectedRepositories = Array.isArray(sourcePayload.selectedRepositories)
    ? sourcePayload.selectedRepositories.filter(
        (value): value is string => typeof value === 'string',
      )
    : undefined;
  const slackOriginMessageTs =
    typeof sourcePayload.slackOriginMessageTs === 'string'
      ? sourcePayload.slackOriginMessageTs
      : undefined;
  const followUpPromptSource = resolveFollowUpPromptSource({
    senderMode,
    source,
  });
  const normalizedClientMessageId = normalizeOptionalString(clientMessageId);
  const payload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
    repo: repo ?? '',
    environmentId,
    port: sourceRun.port ?? undefined,
    sourceSnapshotId: sourceRun.snapshotId,
    sourceRunId: sourceRun.id,
    ...(selectedRepositories ? { selectedRepositories } : {}),
    ...(slackOriginMessageTs ? { slackOriginMessageTs } : {}),
    resumePrompt: message,
    resumePromptSource: followUpPromptSource ?? 'api',
    ...(images?.length ? { resumePromptImages: images } : {}),
    ...(normalizedClientMessageId
      ? { resumePromptClientMessageId: normalizedClientMessageId }
      : {}),
  };
  populateSnapshotResumeSlackMetadata(payload, {
    sourcePayload,
    channel: channelBindings?.slackChannelId,
    threadTs: channelBindings?.slackThreadTs,
  });
  populateSnapshotResumeCommunicationMetadata(payload, {
    sourcePayload,
  });

  await inheritSnapshotResumeVisiblePromptFields(
    payload,
    sourceRun.payload,
    sourceRun.sourceRunId,
  );

  // Resumes never create tasks and never re-attribute; the follow-up sender
  // becomes the new run's acting user.
  const resumeLaunch = await enqueueTask(
    {
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: sourceRun.snapshotId,
        sourceRunId: sourceRun.id,
        payload,
      },
      actingUserId: userId,
    },
    {},
  );

  await maybeCreateSlackReplyQuoteContext({
    runId: resumeLaunch.id,
    payload,
    slackThreadTs: channelBindings?.slackThreadTs ?? null,
    userId,
    message: quoteText,
    senderMode,
  });

  return {
    success: true,
    result: {
      resumed: true,
      runId: resumeLaunch.id,
      taskId,
    },
  };
}

function shouldSkipLinkedReviewHandoffForPrStatus(
  status: PullRequestStatus | null,
): boolean {
  return status !== null && !OPEN_LINKED_REVIEW_HANDOFF_STATUSES.has(status);
}

async function getLinkedReviewHandoffTarget({
  sourceRun,
  targetTaskId,
}: {
  sourceRun: {
    type: TaskPayloadKind | string | null;
    payload: Record<string, unknown>;
  };
  targetTaskId: string;
}): Promise<{
  status: PullRequestStatus | null;
  pullRequest: LinkedReviewFastHandoff['pullRequest'];
}> {
  const repo =
    typeof sourceRun.payload.repo === 'string' ? sourceRun.payload.repo : null;
  const prNumber =
    typeof sourceRun.payload.prNumber === 'number'
      ? sourceRun.payload.prNumber
      : typeof sourceRun.payload.githubPrNumber === 'number'
        ? sourceRun.payload.githubPrNumber
        : null;
  const branchName =
    typeof sourceRun.payload.branchName === 'string'
      ? sourceRun.payload.branchName
      : '';

  if (!repo || !prNumber) {
    throw new Error(
      'Linked review handoff requires PR metadata on the review run.',
    );
  }

  const reusableOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName: repo,
    prNumber,
    branchName,
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      sourceRun.payload,
    ),
  });

  if (!reusableOwner?.taskId) {
    throw new Error(
      'Linked review handoff requires a reusable PR owner task for the PR.',
    );
  }

  if (reusableOwner.taskId !== targetTaskId) {
    throw new Error(
      'Linked review handoff target must match the reusable PR owner task for the PR.',
    );
  }

  const prLink = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.taskId, targetTaskId),
      eq(taskPullRequests.repository, repo),
      eq(taskPullRequests.prNumber, prNumber),
    ),
    columns: {
      host: true,
      prTitle: true,
      prUrl: true,
      status: true,
    },
  });

  const prUrl =
    prLink?.prUrl ??
    (typeof sourceRun.payload.prUrl === 'string'
      ? sourceRun.payload.prUrl
      : null);
  if (!prUrl) {
    throw new Error('Linked review handoff requires a pull request URL.');
  }

  return {
    status: prLink?.status ?? null,
    pullRequest: {
      provider: 'github',
      host: prLink?.host ?? null,
      repository: repo,
      number: prNumber,
      title: prLink?.prTitle ?? null,
      url: prUrl,
      status: prLink?.status ?? null,
    },
  };
}

async function resolveLinkedReviewHandoff({
  authContext,
  senderMode,
  message,
  run,
  targetTaskId,
  fallbackUserId,
}: {
  authContext?: AuthTokenContext | RunTokenContext;
  senderMode?: SendMessageSenderMode;
  message: string;
  run: {
    actingUserId: string | null;
  };
  targetTaskId: string;
  fallbackUserId: string;
}): Promise<
  | {
      kind: 'send';
      senderUserId: string;
      fastHandoff?: LinkedReviewFastHandoff;
    }
  | { kind: 'skip'; reason: string }
> {
  if (senderMode !== 'linked_review_handoff') {
    return { kind: 'send', senderUserId: fallbackUserId };
  }

  if (
    !authContext ||
    authContext.tokenType !== 'run' ||
    !isLinkedReviewResultsMessage(message)
  ) {
    throw new Error('Linked review handoff requires a PR review run token.');
  }

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, authContext.runId),
  });

  if (
    !sourceRun ||
    !REVIEW_HANDOFF_TASK_TYPES.has(sourceRun.payloadKind as TaskPayloadKind)
  ) {
    throw new Error('Linked review handoff requires an active PR review run.');
  }
  const sourcePayload =
    (sourceRun.payload as Record<string, unknown> | null) ?? {};

  const handoffTarget = await getLinkedReviewHandoffTarget({
    sourceRun: {
      type: sourceRun.payloadKind,
      payload: sourcePayload,
    },
    targetTaskId,
  });

  if (shouldSkipLinkedReviewHandoffForPrStatus(handoffTarget.status)) {
    return {
      kind: 'skip',
      reason:
        'Linked review handoff skipped because the pull request is no longer open.',
    };
  }

  const parsedReview = parseLinkedReviewResults(message);
  const reviewHeadSha =
    parsedReview?.currentHeadSha ??
    (typeof sourcePayload.headSha === 'string'
      ? sourcePayload.headSha
      : undefined);
  const summary =
    getLinkedReviewHandoffQuoteText(message) ??
    (parsedReview?.outcome === 'clean'
      ? 'Review completed with no outstanding findings.'
      : (parsedReview?.findingCount ?? 0) > 0
        ? `Review completed with ${parsedReview?.findingCount} outstanding ${parsedReview?.findingCount === 1 ? 'finding' : 'findings'}.`
        : 'Review completed.');
  const hasActionableFindings =
    parsedReview?.outcome === 'findings_remain' ||
    (parsedReview?.findingCount ?? 0) > 0;
  const configuredHandoffTarget =
    sourcePayload.linkedReviewHandoffTarget === 'fast_parent'
      ? 'fast_parent'
      : 'implementation_task';

  return {
    kind: 'send',
    senderUserId: run.actingUserId ?? fallbackUserId,
    fastHandoff: {
      fastParentRequired: configuredHandoffTarget === 'fast_parent',
      reviewRunId: sourceRun.id,
      reviewTaskId: sourceRun.taskId,
      ...(reviewHeadSha ? { reviewHeadSha } : {}),
      pullRequest: handoffTarget.pullRequest,
      summary,
      reviewResult: {
        reviewKind: parsedReview?.reviewKind ?? null,
        outcome: parsedReview?.outcome ?? null,
        findingCount: parsedReview?.findingCount ?? null,
        approvalStatus: parsedReview?.approvalStatus ?? null,
        headSha: reviewHeadSha ?? null,
      },
      ...(hasActionableFindings
        ? {
            suggestedActionQuestion:
              'Would you like me to resolve this feedback?',
            suggestedActionPrompt: `Address the review feedback on ${handoffTarget.pullRequest.repository}#${handoffTarget.pullRequest.number}.`,
          }
        : {}),
    },
  };
}

export async function sendMessageToTask({
  taskId,
  userId,
  authContext,
  message,
  quoteText = message,
  images,
  source,
  clientMessageId,
  senderMode,
  workerQuoteUserName,
  goalContext,
}: {
  taskId: string;
  userId: string;
  authContext?: AuthTokenContext | RunTokenContext;
  message: string;
  quoteText?: string;
  images?: string[];
  source?: string;
  clientMessageId?: string;
  senderMode?: SendMessageSenderMode;
  /**
   * Explicit display name for the worker-side Slack reply quote. When provided,
   * overrides the internal `resolveWorkerQuoteUserName` lookup. Used by the
   * GitHub PR follow-up handler to attribute the quote to the commenter (by
   * linked name or GitHub login) rather than the reusable task owner when the
   * commenter has no linked account.
   */
  workerQuoteUserName?: string;
  goalContext?: TaskGoal;
}): Promise<SendMessageToTaskResult> {
  try {
    const run = await findLatestTaskRun(taskId, {
      id: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      snapshotId: true,
      snapshotCreatedAt: true,
      sourceRunId: true,
      payload: true,
      port: true,
      result: true,
    });

    if (!run) {
      return { success: false, error: 'Task not found', status: 404 };
    }

    const channelBindings = (await getTaskChannelBindings(taskId)) ?? null;

    const linkedReviewHandoff = await resolveLinkedReviewHandoff({
      authContext,
      senderMode,
      message,
      run,
      targetTaskId: taskId,
      fallbackUserId: userId,
    });

    if (linkedReviewHandoff.kind === 'skip') {
      return {
        success: true,
        result: {
          skipped: true,
          reason: linkedReviewHandoff.reason,
        },
      };
    }

    if (
      linkedReviewHandoff.fastHandoff &&
      getFastAgentParentFromPayload(run.payload)
    ) {
      const fastHandoff = linkedReviewHandoff.fastHandoff;
      await notifyFastAgentParentOnPrFeedback({
        run: {
          id: run.id,
          taskId,
          payload: run.payload,
        },
        deliveryIds: [
          `linked-review:${fastHandoff.reviewTaskId}:${fastHandoff.reviewHeadSha ?? fastHandoff.reviewRunId}`,
        ],
        reviewTaskId: fastHandoff.reviewTaskId,
        ...(fastHandoff.reviewHeadSha
          ? { reviewHeadSha: fastHandoff.reviewHeadSha }
          : {}),
        pullRequest: fastHandoff.pullRequest,
        summary: fastHandoff.summary,
        reviewResult: fastHandoff.reviewResult,
        ...(fastHandoff.suggestedActionQuestion
          ? { suggestedActionQuestion: fastHandoff.suggestedActionQuestion }
          : {}),
        ...(fastHandoff.suggestedActionPrompt
          ? { suggestedActionPrompt: fastHandoff.suggestedActionPrompt }
          : {}),
      });
      return {
        success: true,
        result: { sent: true, deliveredToFastParent: true },
      };
    }
    if (linkedReviewHandoff.fastHandoff?.fastParentRequired) {
      return {
        success: true,
        result: {
          skipped: true,
          reason:
            'Linked review handoff skipped because the Fast parent is no longer available.',
        },
      };
    }

    if (isExitedRunStatus(run.status)) {
      if (goalContext) {
        return {
          success: false,
          error: `Task is not active (status: ${run.status})`,
          status: 409,
        };
      }
      const resumeResult = await resumeTaskFromSnapshot({
        taskId,
        userId: linkedReviewHandoff.senderUserId,
        message,
        quoteText,
        images,
        source,
        clientMessageId,
        sourceRun: run as LatestTaskRun,
        channelBindings,
        senderMode,
      });

      if (resumeResult) {
        return resumeResult;
      }

      return {
        success: false,
        error: `Task is not active (status: ${run.status})`,
        status: 409,
      };
    }

    if (!run.sandboxServerUrl) {
      return {
        success: false,
        error: 'Task has no active sandbox. The worker may still be booting.',
        status: 409,
      };
    }

    const senderUserId = linkedReviewHandoff.senderUserId;

    const shouldPreserveActor =
      !!senderMode && ACTOR_PRESERVING_MODES.has(senderMode);
    const requiresActorHandoff =
      !shouldPreserveActor && run.actingUserId !== senderUserId;

    let didSwitchActingUser = false;

    try {
      await maybeCreateSlackReplyQuoteContext({
        runId: run.id,
        payload: run.payload as Record<string, unknown> | null,
        slackThreadTs: channelBindings?.slackThreadTs ?? null,
        userId: senderUserId,
        message: quoteText,
        senderMode,
      });

      const followUpPromptSource = resolveFollowUpPromptSource({
        senderMode,
        source,
      });
      const normalizedClientMessageId =
        normalizeOptionalString(clientMessageId);
      const resolvedQuoteUserName =
        workerQuoteUserName ??
        (await resolveWorkerQuoteUserName(senderMode, senderUserId));

      // The actor switch must land before the prompt reaches the sandbox so
      // credential resolution and turn attribution agree. See
      // syncActingUserIdBeforeDelivery for the ordering rationale.
      didSwitchActingUser = await syncActingUserIdBeforeDelivery({
        runId: run.id,
        currentActingUserId: run.actingUserId,
        nextActingUserId: senderUserId,
        preserveActor: shouldPreserveActor,
      });

      const result = await withSandboxServerRpcClient({
        runId: run.id,
        userId: senderUserId,
        sandboxServerUrl: run.sandboxServerUrl,
        fetch: fetchSandboxRpcResponseOrThrowIfNotReady,
        call: async (client) => {
          const currentGoal = goalContext
            ? null
            : await getTaskGoalForRun(run.id);
          const resolvedGoalContext =
            goalContext ??
            (currentGoal?.status === 'active' ? currentGoal : undefined);
          return client.commands.sendPrompt.mutate({
            prompt: message,
            quoteText,
            ...(followUpPromptSource ? { source: followUpPromptSource } : {}),
            ...(normalizedClientMessageId
              ? { clientMessageId: normalizedClientMessageId }
              : {}),
            ...(resolvedQuoteUserName
              ? { userName: resolvedQuoteUserName }
              : {}),
            // Do not leave the previous actor's turn running after the live
            // credential identity changes. Native steering injects at the
            // next step; fallback steering aborts and replays promptly.
            ...(requiresActorHandoff ? { autoSteerWhenQueued: true } : {}),
            ...(goalContext ? { autoSteerWhenQueued: true } : {}),
            ...(images?.length ? { images } : {}),
            ...(resolvedGoalContext
              ? { goalContext: resolvedGoalContext }
              : {}),
          });
        },
      });

      return { success: true, result };
    } catch (error) {
      if (didSwitchActingUser) {
        await restoreActingUserIdAfterFailedDelivery({
          handlerName: 'sendMessageToTask',
          runId: run.id,
          previousActingUserId: run.actingUserId,
          attemptedActingUserId: senderUserId,
        });
      }

      if (error instanceof SandboxNotReadyError) {
        return {
          success: false,
          error: error.message,
          status: 409,
        };
      }

      if (error instanceof TRPCClientError) {
        if (error.cause instanceof SandboxNotReadyError) {
          return {
            success: false,
            error: error.cause.message,
            status: 409,
          };
        }

        return {
          success: false,
          error: `Sandbox error: ${error.message}`,
          status: 502,
        };
      }

      throw error;
    }
  } catch (error) {
    logHandlerError('sendMessageToTask', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message',
      status: 500,
    };
  }
}

export async function steerMessageToTask({
  taskId,
  userId,
  message,
  quoteText = message,
  images,
  senderMode,
  workerQuoteUserName,
}: {
  taskId: string;
  userId: string;
  message: string;
  quoteText?: string;
  images?: string[];
  senderMode?: SendMessageSenderMode;
  /**
   * Explicit display name for the worker-side Slack reply quote. See
   * {@link sendMessageToTask} for semantics.
   */
  workerQuoteUserName?: string;
}): Promise<SendMessageToTaskResult> {
  try {
    const run = await findLatestTaskRun(taskId, {
      id: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      snapshotId: true,
      snapshotCreatedAt: true,
      sourceRunId: true,
      payload: true,
      port: true,
      result: true,
    });

    if (!run) {
      return { success: false, error: 'Task not found', status: 404 };
    }

    const channelBindings = (await getTaskChannelBindings(taskId)) ?? null;

    if (isExitedRunStatus(run.status)) {
      const resumeResult = await resumeTaskFromSnapshot({
        taskId,
        userId,
        message,
        quoteText,
        images,
        sourceRun: run as LatestTaskRun,
        channelBindings,
        senderMode,
      });

      if (resumeResult) {
        return resumeResult;
      }

      return {
        success: false,
        error: `Task is not active (status: ${run.status})`,
        status: 409,
      };
    }

    if (!run.sandboxServerUrl) {
      return {
        success: false,
        error: 'Task has no active sandbox. The worker may still be booting.',
        status: 409,
      };
    }

    let didSwitchActingUser = false;

    try {
      await maybeCreateSlackReplyQuoteContext({
        runId: run.id,
        payload: run.payload as Record<string, unknown> | null,
        slackThreadTs: channelBindings?.slackThreadTs ?? null,
        userId,
        message: quoteText,
        senderMode,
      });

      const resolvedQuoteUserName =
        workerQuoteUserName ??
        (await resolveWorkerQuoteUserName(senderMode, userId));

      // The actor switch must land before the steer reaches the sandbox so
      // credential resolution and turn attribution agree. See
      // syncActingUserIdBeforeDelivery for the ordering rationale.
      didSwitchActingUser = await syncActingUserIdBeforeDelivery({
        runId: run.id,
        currentActingUserId: run.actingUserId,
        nextActingUserId: userId,
        preserveActor: false,
      });

      const result = await withSandboxServerRpcClient({
        runId: run.id,
        userId,
        sandboxServerUrl: run.sandboxServerUrl,
        fetch: fetchSandboxRpcResponseOrThrowIfNotReady,
        call: async (client) => {
          const goal = await getTaskGoalForRun(run.id);
          return client.commands.steerTask.mutate({
            prompt: message,
            quoteText,
            ...(getFastAgentParentFromPayload(run.payload)
              ? { answerPendingInput: true }
              : {}),
            ...(resolvedQuoteUserName
              ? { userName: resolvedQuoteUserName }
              : {}),
            ...(senderMode === 'fast_agent'
              ? { suppressSlackReplyQuote: true }
              : {}),
            ...(images?.length ? { images } : {}),
            ...(goal?.status === 'active' ? { goalContext: goal } : {}),
          });
        },
      });

      return { success: true, result };
    } catch (error) {
      if (didSwitchActingUser) {
        await restoreActingUserIdAfterFailedDelivery({
          handlerName: 'steerMessageToTask',
          runId: run.id,
          previousActingUserId: run.actingUserId,
          attemptedActingUserId: userId,
        });
      }

      if (error instanceof SandboxNotReadyError) {
        return {
          success: false,
          error: error.message,
          status: 409,
        };
      }

      if (error instanceof TRPCClientError) {
        if (error.cause instanceof SandboxNotReadyError) {
          return {
            success: false,
            error: error.cause.message,
            status: 409,
          };
        }

        return {
          success: false,
          error: `Sandbox error: ${error.message}`,
          status: 502,
        };
      }

      throw error;
    }
  } catch (error) {
    logHandlerError('steerMessageToTask', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message',
      status: 500,
    };
  }
}
