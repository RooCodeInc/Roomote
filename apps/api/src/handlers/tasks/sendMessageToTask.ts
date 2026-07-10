import { TRPCClientError } from '@trpc/client';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { withSandboxServerRpcClient } from '@roomote/sdk/server';
import {
  and,
  db,
  eq,
  findReusableGitHubPrFollowUpOwner,
  taskPullRequests,
  taskRuns,
  users,
} from '@roomote/db/server';
import type {
  AuthTokenContext,
  CloudTaskPayload,
  JobTokenContext,
  PullRequestStatus,
} from '@roomote/types';
import {
  TaskPayloadKind,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  isLinkedReviewResultsMessage,
  isExitedCloudTaskStatus,
  isSnapshotResumable,
  parseLinkedReviewResults,
  populateSnapshotResumeSlackMetadata,
  resolveSourceControlProviderFromPayload,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import {
  hasSlackThreadReplyContext,
  trackLatestUserMessageForSlackQuote,
} from '@roomote/slack';

import { findLatestCloudJob, getTaskChannelBindings } from './helpers';
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
  'linked_review_handoff',
  'github_pr_follow_up',
]);

function shouldTrackSlackReplyQuoteContext(
  senderMode?: SendMessageSenderMode,
): boolean {
  return !(senderMode && SLACK_REPLY_QUOTE_SUPPRESSING_MODES.has(senderMode));
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

type LatestTaskCloudJob = {
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
  cloudJobId: number;
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
      cloudJobId: params.cloudJobId,
      text,
      userName,
      onError: (error) => {
        logHandlerError(
          'sendMessageToTask',
          `Non-fatal latest user message sync failure for cloud job ${params.cloudJobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    });
  } catch (error) {
    logHandlerError(
      'sendMessageToTask',
      `Non-fatal latest user message sync failure for cloud job ${params.cloudJobId}: ${
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
  cloudJobId: number;
  payload: Record<string, unknown> | null;
  slackThreadTs: string | null;
  message: string;
}): Promise<void> {
  const quoteText = getLinkedReviewHandoffQuoteText(params.message);

  if (!quoteText) {
    return;
  }

  await createSlackReplyQuoteContext({
    cloudJobId: params.cloudJobId,
    payload: params.payload,
    slackThreadTs: params.slackThreadTs,
    userId: 'linked-review-handoff',
    userName: 'Review',
    message: quoteText,
  });
}

async function maybeCreateSlackReplyQuoteContext(params: {
  cloudJobId: number;
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

  if (!shouldTrackSlackReplyQuoteContext(params.senderMode)) {
    return;
  }

  await createSlackReplyQuoteContext(params);
}

async function updateActingUserIdIfNeeded({
  jobId,
  currentActingUserId,
  nextActingUserId,
  preserveActor,
}: {
  jobId: number;
  currentActingUserId: string | null;
  nextActingUserId: string;
  preserveActor: boolean;
}): Promise<void> {
  if (preserveActor || currentActingUserId === nextActingUserId) {
    return;
  }

  await db
    .update(taskRuns)
    .set({ actingUserId: nextActingUserId })
    .where(eq(taskRuns.id, jobId));
}

async function syncActingUserIdAfterDelivery({
  handlerName,
  jobId,
  currentActingUserId,
  nextActingUserId,
  preserveActor,
}: {
  handlerName: 'sendMessageToTask' | 'steerMessageToTask';
  jobId: number;
  currentActingUserId: string | null;
  nextActingUserId: string;
  preserveActor: boolean;
}): Promise<void> {
  try {
    await updateActingUserIdIfNeeded({
      jobId,
      currentActingUserId,
      nextActingUserId,
      preserveActor,
    });
  } catch (error) {
    logHandlerError(
      handlerName,
      `Non-fatal actingUserId sync failure for cloud job ${jobId} ` +
        `(current=${currentActingUserId ?? 'null'}, next=${nextActingUserId}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  images,
  source,
  clientMessageId,
  sourceJob,
  channelBindings,
  senderMode,
}: {
  taskId: string;
  userId: string;
  message: string;
  images?: string[];
  source?: string;
  clientMessageId?: string;
  sourceJob: LatestTaskCloudJob;
  channelBindings: TaskChannelBindingsRow | null;
  senderMode?: SendMessageSenderMode;
}): Promise<SendMessageToTaskResult | null> {
  if (!sourceJob.snapshotId) {
    return null;
  }

  if (!isSnapshotResumable(sourceJob.snapshotCreatedAt)) {
    return {
      success: false,
      error: EXPIRED_SNAPSHOT_RESUME_ERROR,
      status: 409,
    };
  }

  const sourcePayload = sourceJob.payload ?? {};
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
  const payload: CloudTaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
    repo: repo ?? '',
    environmentId,
    port: sourceJob.port ?? undefined,
    sourceSnapshotId: sourceJob.snapshotId,
    sourceCloudJobId: sourceJob.id,
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

  await inheritSnapshotResumeVisiblePromptFields(
    payload,
    sourceJob.payload,
    sourceJob.sourceRunId,
  );

  // Resumes never create tasks and never re-attribute; the follow-up sender
  // becomes the new run's acting user.
  const resumeLaunch = await enqueueCloudTask(
    {
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: sourceJob.snapshotId,
        sourceCloudJobId: sourceJob.id,
        payload,
      },
      actingUserId: userId,
    },
    {},
  );

  await maybeCreateSlackReplyQuoteContext({
    cloudJobId: resumeLaunch.id,
    payload,
    slackThreadTs: channelBindings?.slackThreadTs ?? null,
    userId,
    message,
    senderMode,
  });

  return {
    success: true,
    result: {
      resumed: true,
      cloudJobId: resumeLaunch.id,
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
  sourceJob,
  targetTaskId,
}: {
  sourceJob: {
    type: TaskPayloadKind | string | null;
    payload: Record<string, unknown>;
  };
  targetTaskId: string;
}): Promise<{ status: PullRequestStatus | null }> {
  const repo =
    typeof sourceJob.payload.repo === 'string' ? sourceJob.payload.repo : null;
  const prNumber =
    typeof sourceJob.payload.prNumber === 'number'
      ? sourceJob.payload.prNumber
      : typeof sourceJob.payload.githubPrNumber === 'number'
        ? sourceJob.payload.githubPrNumber
        : null;
  const branchName =
    typeof sourceJob.payload.branchName === 'string'
      ? sourceJob.payload.branchName
      : '';

  if (!repo || !prNumber) {
    throw new Error(
      'Linked review handoff requires PR metadata on the review job.',
    );
  }

  const reusableOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName: repo,
    prNumber,
    branchName,
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      sourceJob.payload,
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
      status: true,
    },
  });

  return { status: prLink?.status ?? null };
}

async function resolveLinkedReviewHandoff({
  authContext,
  senderMode,
  message,
  job,
  targetTaskId,
  fallbackUserId,
}: {
  authContext?: AuthTokenContext | JobTokenContext;
  senderMode?: SendMessageSenderMode;
  message: string;
  job: {
    actingUserId: string | null;
  };
  targetTaskId: string;
  fallbackUserId: string;
}): Promise<
  { kind: 'send'; senderUserId: string } | { kind: 'skip'; reason: string }
> {
  if (senderMode !== 'linked_review_handoff') {
    return { kind: 'send', senderUserId: fallbackUserId };
  }

  if (
    !authContext ||
    authContext.tokenType !== 'cj' ||
    !isLinkedReviewResultsMessage(message)
  ) {
    throw new Error('Linked review handoff requires a PR review job token.');
  }

  const sourceJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, authContext.cloudJobId),
  });

  if (
    !sourceJob ||
    !REVIEW_HANDOFF_TASK_TYPES.has(sourceJob.payloadKind as TaskPayloadKind)
  ) {
    throw new Error('Linked review handoff requires an active PR review job.');
  }

  const handoffTarget = await getLinkedReviewHandoffTarget({
    sourceJob: {
      type: sourceJob.payloadKind,
      payload: (sourceJob.payload as Record<string, unknown> | null) ?? {},
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

  return {
    kind: 'send',
    senderUserId: job.actingUserId ?? fallbackUserId,
  };
}

export async function sendMessageToTask({
  taskId,
  userId,
  authContext,
  message,
  images,
  source,
  clientMessageId,
  senderMode,
  workerQuoteUserName,
}: {
  taskId: string;
  userId: string;
  authContext?: AuthTokenContext | JobTokenContext;
  message: string;
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
}): Promise<SendMessageToTaskResult> {
  try {
    const job = await findLatestCloudJob(taskId, {
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

    if (!job) {
      return { success: false, error: 'Task not found', status: 404 };
    }

    const channelBindings = (await getTaskChannelBindings(taskId)) ?? null;

    const linkedReviewHandoff = await resolveLinkedReviewHandoff({
      authContext,
      senderMode,
      message,
      job,
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

    if (isExitedCloudTaskStatus(job.status)) {
      const resumeResult = await resumeTaskFromSnapshot({
        taskId,
        userId: linkedReviewHandoff.senderUserId,
        message,
        images,
        source,
        clientMessageId,
        sourceJob: job as LatestTaskCloudJob,
        channelBindings,
        senderMode,
      });

      if (resumeResult) {
        return resumeResult;
      }

      return {
        success: false,
        error: `Task is not active (status: ${job.status})`,
        status: 409,
      };
    }

    if (!job.sandboxServerUrl) {
      return {
        success: false,
        error: 'Task has no active sandbox. The worker may still be booting.',
        status: 409,
      };
    }

    const senderUserId = linkedReviewHandoff.senderUserId;

    const shouldPreserveActor =
      !!senderMode && ACTOR_PRESERVING_MODES.has(senderMode);

    try {
      await maybeCreateSlackReplyQuoteContext({
        cloudJobId: job.id,
        payload: job.payload as Record<string, unknown> | null,
        slackThreadTs: channelBindings?.slackThreadTs ?? null,
        userId: senderUserId,
        message,
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
      const result = await withSandboxServerRpcClient({
        cloudJobId: job.id,
        userId: senderUserId,
        sandboxServerUrl: job.sandboxServerUrl,
        fetch: fetchSandboxRpcResponseOrThrowIfNotReady,
        call: (client) =>
          client.commands.sendPrompt.mutate({
            prompt: message,
            ...(followUpPromptSource ? { source: followUpPromptSource } : {}),
            ...(normalizedClientMessageId
              ? { clientMessageId: normalizedClientMessageId }
              : {}),
            ...(resolvedQuoteUserName
              ? { userName: resolvedQuoteUserName }
              : {}),
            ...(images?.length ? { images } : {}),
          }),
      });

      await syncActingUserIdAfterDelivery({
        handlerName: 'sendMessageToTask',
        jobId: job.id,
        currentActingUserId: job.actingUserId,
        nextActingUserId: senderUserId,
        preserveActor: shouldPreserveActor,
      });

      return { success: true, result };
    } catch (error) {
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
  images,
  senderMode,
  workerQuoteUserName,
}: {
  taskId: string;
  userId: string;
  message: string;
  images?: string[];
  senderMode?: SendMessageSenderMode;
  /**
   * Explicit display name for the worker-side Slack reply quote. See
   * {@link sendMessageToTask} for semantics.
   */
  workerQuoteUserName?: string;
}): Promise<SendMessageToTaskResult> {
  try {
    const job = await findLatestCloudJob(taskId, {
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

    if (!job) {
      return { success: false, error: 'Task not found', status: 404 };
    }

    const channelBindings = (await getTaskChannelBindings(taskId)) ?? null;

    if (isExitedCloudTaskStatus(job.status)) {
      const resumeResult = await resumeTaskFromSnapshot({
        taskId,
        userId,
        message,
        images,
        sourceJob: job as LatestTaskCloudJob,
        channelBindings,
        senderMode,
      });

      if (resumeResult) {
        return resumeResult;
      }

      return {
        success: false,
        error: `Task is not active (status: ${job.status})`,
        status: 409,
      };
    }

    if (!job.sandboxServerUrl) {
      return {
        success: false,
        error: 'Task has no active sandbox. The worker may still be booting.',
        status: 409,
      };
    }

    try {
      await maybeCreateSlackReplyQuoteContext({
        cloudJobId: job.id,
        payload: job.payload as Record<string, unknown> | null,
        slackThreadTs: channelBindings?.slackThreadTs ?? null,
        userId,
        message,
        senderMode,
      });

      const resolvedQuoteUserName =
        workerQuoteUserName ??
        (await resolveWorkerQuoteUserName(senderMode, userId));
      const result = await withSandboxServerRpcClient({
        cloudJobId: job.id,
        userId,
        sandboxServerUrl: job.sandboxServerUrl,
        fetch: fetchSandboxRpcResponseOrThrowIfNotReady,
        call: (client) =>
          client.commands.steerTask.mutate({
            prompt: message,
            ...(resolvedQuoteUserName
              ? { userName: resolvedQuoteUserName }
              : {}),
            ...(images?.length ? { images } : {}),
          }),
      });

      await syncActingUserIdAfterDelivery({
        handlerName: 'steerMessageToTask',
        jobId: job.id,
        currentActingUserId: job.actingUserId,
        nextActingUserId: userId,
        preserveActor: false,
      });

      return { success: true, result };
    } catch (error) {
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
