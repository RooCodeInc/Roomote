import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentTaskLauncher,
  fastAgentConversationRepository,
  type FastAgentTurnAdapter,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';
import {
  asc,
  and,
  db,
  eq,
  inArray,
  slackInstallations,
  taskArtifacts,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import { Env, getArtifactSigningKey } from '@roomote/env';
import {
  buildSlackPrReviewActionBlocks,
  createFastAgentSlackLiveTaskLauncher,
  resolveSlackReactionNames,
  SlackNotifier,
} from '@roomote/slack';
import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  buildPrReviewActionCallbackData,
  TaskPayloadKind,
  exitedRunStatuses,
  type FastAgentConversation,
  type FastAgentParent,
  type PullRequestStatus,
  type RunStatus,
  type TaskRunErrorCode,
  type SourceControlProvider,
  type StandardTask,
} from '@roomote/types';

import { resolveUserMcpServerConfigs } from '../routers/mcp-connections';

import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from './artifacts/raw-url';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import {
  attachPendingPrReviewActionMessage,
  setPendingPrReviewAction,
} from './task-runs/pr-review-action';

const EXITED_RUN_STATUSES = new Set<RunStatus>(exitedRunStatuses);

/** Deterministic uuid-shaped Slack client_msg_id so a retried delivery of the
 * same event posts with the same idempotency key instead of duplicating. */
export function buildSlackClientMessageId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class FastAgentParentEventDeliveryError extends Error {
  /** True once the orchestrator's reply reached the chat; callers must not
   * release their delivery claim in that case or a retry double-posts. */
  readonly replyPosted: boolean;
  /** True when no retry can ever succeed (parent session or surface
   * installation is gone); callers should stop retrying. */
  readonly permanent: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; replyPosted: boolean; permanent?: boolean },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'FastAgentParentEventDeliveryError';
    this.replyPosted = options.replyPosted;
    this.permanent = options.permanent ?? false;
  }
}

export type FastAgentPullRequestContext = {
  provider: SourceControlProvider;
  host: string | null;
  repository: string | null;
  number: number | null;
  title: string | null;
  url: string;
  status: PullRequestStatus | null;
};

type FastAgentParentEvent =
  | {
      type: 'child_message';
      taskId: string;
      runId: number;
      messageId: string;
      purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
      message: string;
      imageArtifactIds?: string[];
    }
  | {
      type: 'artifact_published';
      taskId: string;
      runId: number;
      artifact: {
        id: string;
        path: string;
        version: number;
        contentType: string;
        viewUrl: string;
      };
    }
  | {
      type: 'task_settled';
      taskId: string;
      runId: number;
      title?: string;
      status: string;
      error?: string;
      errorCode?: TaskRunErrorCode;
      taskUrl: string;
      pullRequests: FastAgentPullRequestContext[];
    }
  | {
      type: 'pull_request_opened';
      taskId: string;
      runId: number;
      taskUrl: string;
      untrustedTaskGeneratedContext?: string;
      pullRequest: FastAgentPullRequestContext;
    }
  | {
      type: 'pull_request_feedback';
      feedbackId: string;
      taskId: string;
      runId: number;
      taskUrl: string;
      pullRequest: FastAgentPullRequestContext;
      summary: string;
      suggestedActionQuestion?: string;
      suggestedActionPrompt?: string;
      reviewResult?: {
        reviewKind: 'initial' | 'sync' | null;
        outcome: string | null;
        findingCount: number | null;
        approvalStatus: 'approved' | 'skipped' | null;
        headSha: string | null;
      };
    }
  | {
      type: 'pull_request_status_changed';
      taskId: string;
      runId: number;
      taskUrl: string;
      pullRequest: FastAgentPullRequestContext;
      status: 'merged' | 'closed';
      actorLogin: string;
    };

export async function listFastAgentPullRequestContexts(
  taskId: string,
): Promise<FastAgentPullRequestContext[]> {
  const rows = await db.query.taskPullRequests.findMany({
    where: eq(taskPullRequests.taskId, taskId),
    columns: {
      sourceControlProvider: true,
      host: true,
      repository: true,
      prNumber: true,
      prTitle: true,
      prUrl: true,
      status: true,
    },
    orderBy: [
      asc(taskPullRequests.detectedAt),
      asc(taskPullRequests.createdAt),
    ],
  });

  return rows.map((row) => ({
    provider: row.sourceControlProvider,
    host: row.host,
    repository: row.repository,
    number: row.prNumber,
    title: row.prTitle,
    url: row.prUrl,
    status: row.status,
  }));
}

type FastAgentEventImage = {
  url: string;
  altText: string;
  contentType: string;
};

async function buildSelectedImages(params: {
  artifactIds: string[];
  event: FastAgentParentEvent;
}): Promise<FastAgentEventImage[]> {
  const artifactIds = [...new Set(params.artifactIds)];
  if (
    artifactIds.length === 0 ||
    (params.event.type !== 'artifact_published' &&
      params.event.type !== 'child_message') ||
    (params.event.type === 'child_message' &&
      !params.event.imageArtifactIds?.length)
  ) {
    return [];
  }

  const allowedIds = new Set(
    params.event.type === 'artifact_published'
      ? [params.event.artifact.id]
      : params.event.type === 'child_message'
        ? (params.event.imageArtifactIds ?? [])
        : [],
  );
  if (artifactIds.some((id) => !allowedIds.has(id))) {
    throw new Error('Fast parent selected an artifact outside this event.');
  }

  const artifacts = await db.query.taskArtifacts.findMany({
    where: inArray(taskArtifacts.id, artifactIds),
    columns: {
      id: true,
      taskId: true,
      runId: true,
      path: true,
      contentType: true,
      uploaded: true,
    },
  });
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const ts = currentEpochSeconds();

  return artifactIds.map((id) => {
    const artifact = byId.get(id);
    if (
      !artifact ||
      !artifact.uploaded ||
      artifact.taskId !== params.event.taskId ||
      artifact.runId !== params.event.runId ||
      !artifact.contentType.startsWith('image/')
    ) {
      throw new Error(`Invalid Fast parent image artifact: ${id}`);
    }

    return {
      url: buildSignedArtifactRawUrl({
        artifactId: artifact.id,
        ts,
        apiBaseUrl: Env.R_APP_URL,
        signingKey: getArtifactSigningKey(),
      }),
      altText: basename(artifact.path) || 'Task artifact',
      contentType: artifact.contentType,
    };
  });
}

function buildEventClientMessageSeed(event: FastAgentParentEvent): string {
  switch (event.type) {
    case 'child_message':
      return `fast-parent-child-message:${event.messageId}`;
    case 'artifact_published':
      return `fast-parent-artifact:${event.artifact.id}:v${event.artifact.version}`;
    case 'pull_request_opened':
      return `fast-parent-pr-opened:${event.taskId}:${event.pullRequest.url}`;
    case 'pull_request_feedback':
      return `fast-parent-pr-feedback:${event.feedbackId}`;
    case 'pull_request_status_changed':
      return `fast-parent-pr-status:${event.taskId}:${event.pullRequest.url}:${event.status}`;
    case 'task_settled':
      return `fast-parent-settle:${event.runId}`;
  }
}

type FastAgentParentTurn = {
  userId: string;
  conversation: FastAgentConversation;
  adapter: FastAgentTurnAdapter;
};

async function createSlackFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'slack') {
    throw new Error('Expected a Slack Fast parent conversation.');
  }

  const [session, installation] = await Promise.all([
    fastAgentConversationRepository.findById({
      id: params.parent.sessionId,
      fallbackConversation,
    }),
    db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, fallbackConversation.workspaceId),
      ),
      columns: { botAccessToken: true, teamDomain: true },
    }),
  ]);

  if (
    !session ||
    session.conversation.surface !== 'slack' ||
    !installation?.botAccessToken
  ) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent session or Slack installation was not found.',
      { replyPosted: false, permanent: true },
    );
  }

  const conversation = session.conversation;
  const slack = new SlackNotifier(installation.botAccessToken);

  if (
    params.event.type === 'pull_request_status_changed' &&
    params.event.status === 'merged'
  ) {
    const { completionEmoji } = await resolveSlackReactionNames();
    await slack.addReaction({
      channel: conversation.replyTarget.channelId,
      timestamp: conversation.replyTarget.threadId,
      name: completionEmoji,
    });
  }

  return {
    userId: session.userId,
    conversation,
    adapter: {
      launchTask: createFastAgentSlackLiveTaskLauncher({
        slack,
        userId: session.userId,
        teamId: conversation.workspaceId,
        ...(installation.teamDomain
          ? { teamDomain: installation.teamDomain }
          : {}),
        channelId: conversation.replyTarget.channelId,
        threadTs: conversation.replyTarget.threadId,
      }),
      postReply: async ({ message, imageArtifactIds = [] }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
        });
        const action =
          params.event.type === 'pull_request_feedback' &&
          params.event.suggestedActionQuestion &&
          params.event.suggestedActionPrompt &&
          params.event.pullRequest.repository &&
          params.event.pullRequest.number
            ? {
                nonce: randomUUID(),
                question: params.event.suggestedActionQuestion,
                followUpPrompt: params.event.suggestedActionPrompt,
                repository: params.event.pullRequest.repository,
                prNumber: params.event.pullRequest.number,
                prUrl: params.event.pullRequest.url,
              }
            : null;

        if (action) {
          await setPendingPrReviewAction({
            nonce: action.nonce,
            provider: 'slack',
            slackTeamId: conversation.workspaceId,
            taskId: params.event.taskId,
            repository: action.repository,
            prNumber: action.prNumber,
            prUrl: action.prUrl,
            channelId: conversation.replyTarget.channelId,
            threadId: conversation.replyTarget.threadId,
            followUpPrompt: action.followUpPrompt,
          });
        }
        const messageTs = await slack.postMessage({
          channel: conversation.replyTarget.channelId,
          thread_ts: conversation.replyTarget.threadId,
          text: action ? `${message}\n${action.question}` : message,
          blocks: action
            ? buildSlackPrReviewActionBlocks({
                text: message,
                question: action.question,
                nonce: action.nonce,
              })
            : [
                { type: 'markdown', text: message },
                ...images.map((image) => ({
                  type: 'image' as const,
                  image_url: image.url,
                  alt_text: image.altText,
                })),
              ],
          unfurl_links: false,
          unfurl_media: false,
          client_msg_id: buildSlackClientMessageId(
            buildEventClientMessageSeed(params.event),
          ),
        });
        if (!messageTs) {
          throw new Error(
            'Slack did not return a Fast parent event timestamp.',
          );
        }
        if (action) {
          await attachPendingPrReviewActionMessage(action.nonce, messageTs);
        }
        params.onReplyPosted();
      },
    },
  };
}

function createFastAgentDiscordTaskLauncher(params: {
  provider: NonNullable<
    Awaited<
      ReturnType<
        typeof createDiscordCommunicationProviderFromRuntimeCredentials
      >
    >
  >;
  userId: string;
  conversation: Extract<FastAgentConversation, { surface: 'discord' }>;
}): LaunchFastAgentTask {
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'discord',
    taskUrlCampaign: 'fast-delegation',
    buildTask: async ({ prompt, environmentId, model, parentSessionId }) => {
      const isDirectMessage = params.conversation.workspaceId === 'dm';
      const thread = isDirectMessage
        ? null
        : await params.provider.createTaskThread({
            channelId: params.conversation.replyTarget.channelId,
            name: buildCommunicationTaskThreadName(prompt),
            initialText: `Delegated by Fast:\n\n${prompt}`,
          });
      return {
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: ALL_REPOSITORIES,
          description: prompt,
          communicationProvider: 'discord',
          communicationChannelId:
            thread?.parentChannelId ??
            params.conversation.replyTarget.channelId,
          ...(thread?.channelId
            ? { communicationThreadId: thread.channelId }
            : isDirectMessage
              ? {}
              : params.conversation.replyTarget.threadId
                ? {
                    communicationThreadId:
                      params.conversation.replyTarget.threadId,
                  }
                : {}),
          ...(thread?.messageId
            ? { communicationMessageId: thread.messageId }
            : {}),
          ...(isDirectMessage
            ? {}
            : { communicationGuildId: params.conversation.workspaceId }),
          ...(thread ? { discordTaskThread: true } : {}),
          ...buildFastAgentChildTaskMetadata({
            sessionId: parentSessionId,
            conversation: params.conversation,
          }),
          ...(environmentId && environmentId !== ALL_REPOSITORIES
            ? { environmentId }
            : {}),
          ...(model
            ? { harnessModelOverrides: { 'opencode-server': model } }
            : {}),
        },
      } satisfies StandardTask;
    },
  });
}

async function createDiscordFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'discord') {
    throw new Error('Expected a Discord Fast parent conversation.');
  }

  const [session, provider] = await Promise.all([
    fastAgentConversationRepository.findById({
      id: params.parent.sessionId,
      fallbackConversation,
    }),
    createDiscordCommunicationProviderFromRuntimeCredentials(),
  ]);
  if (!session || session.conversation.surface !== 'discord' || !provider) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent session or Discord credentials were not found.',
      { replyPosted: false, permanent: true },
    );
  }

  const conversation = session.conversation;
  return {
    userId: session.userId,
    conversation,
    adapter: {
      launchTask: createFastAgentDiscordTaskLauncher({
        provider,
        userId: session.userId,
        conversation,
      }),
      postReply: async ({ message, imageArtifactIds = [] }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
        });
        const action =
          params.event.type === 'pull_request_feedback' &&
          params.event.suggestedActionQuestion &&
          params.event.suggestedActionPrompt &&
          params.event.pullRequest.repository &&
          params.event.pullRequest.number
            ? {
                nonce: randomUUID(),
                question: params.event.suggestedActionQuestion,
                followUpPrompt: params.event.suggestedActionPrompt,
                repository: params.event.pullRequest.repository,
                prNumber: params.event.pullRequest.number,
                prUrl: params.event.pullRequest.url,
              }
            : null;

        if (action) {
          await setPendingPrReviewAction({
            nonce: action.nonce,
            provider: 'discord',
            taskId: params.event.taskId,
            repository: action.repository,
            prNumber: action.prNumber,
            prUrl: action.prUrl,
            channelId: conversation.replyTarget.channelId,
            threadId: conversation.replyTarget.threadId ?? null,
            followUpPrompt: action.followUpPrompt,
          });
        }

        const posted = await provider.postMessage({
          ...conversation.replyTarget,
          idempotencyKey: buildEventClientMessageSeed(params.event),
          text: action ? `${message}\n${action.question}` : message,
          textFormat: 'markdown',
          images,
          ...(action
            ? {
                buttons: [
                  [
                    {
                      text: 'Resolve these issues',
                      callbackData: buildPrReviewActionCallbackData(
                        'yes',
                        action.nonce,
                      ),
                    },
                    {
                      text: 'Auto-resolve on this PR',
                      callbackData: buildPrReviewActionCallbackData(
                        'auto',
                        action.nonce,
                      ),
                    },
                    {
                      text: 'Dismiss',
                      callbackData: buildPrReviewActionCallbackData(
                        'dismiss',
                        action.nonce,
                      ),
                    },
                  ],
                ],
              }
            : {}),
        });
        if (action) {
          await attachPendingPrReviewActionMessage(
            action.nonce,
            posted.lastTextMessageId ?? posted.messageId,
          );
        }
        params.onReplyPosted();
      },
    },
  };
}

async function createFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  switch (params.parent.conversation.surface) {
    case 'slack':
      return createSlackFastAgentParentTurn(params);
    case 'discord':
      return createDiscordFastAgentParentTurn(params);
  }
}

/** Give a structured child event to the Fast orchestrator for presentation. */
export async function deliverFastAgentParentEvent(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  retryTaskStart?: () => Promise<
    { success: true; runId: number } | { success: false; error: string }
  >;
  /** Cap the turn-lock wait so callers holding an HTTP request can fail fast
   * and lean on their own retry instead of blocking. */
  lockWaitMs?: number;
}): Promise<'delivered' | 'skipped'> {
  const conversation = params.parent.conversation;
  const releaseTurnLock = await acquireFastAgentTurnLock({
    conversation,
    ...(params.lockWaitMs !== undefined
      ? { maxWaitMs: params.lockWaitMs }
      : {}),
  });
  if (!releaseTurnLock) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent turn lock did not become available.',
      { replyPosted: false },
    );
  }

  let replyPosted = false;

  try {
    if (params.event.type === 'pull_request_opened') {
      const currentRun = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, params.event.runId),
        columns: { status: true },
      });
      if (!currentRun || EXITED_RUN_STATUSES.has(currentRun.status)) {
        return 'skipped';
      }
    }

    const parentTurn = await createFastAgentParentTurn({
      parent: params.parent,
      event: params.event,
      onReplyPosted: () => {
        replyPosted = true;
      },
    });
    await answerFastAgentQuestion({
      question: `<delegated_task_event>${JSON.stringify(params.event)}</delegated_task_event>`,
      userId: parentTurn.userId,
      conversation: parentTurn.conversation,
      signal: releaseTurnLock.signal,
      turnSource: 'platform_event',
      platformEventHandling:
        params.event.type === 'pull_request_feedback'
          ? 'present_only'
          : 'default',
      platformEventVisibility:
        params.event.type === 'pull_request_feedback' ? 'required' : 'optional',
      adapter: {
        ...parentTurn.adapter,
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId: parentTurn.userId,
            apiBaseUrl: Env.R_APP_URL,
            includeRoomote: true,
          }),
        ...(params.retryTaskStart
          ? { retryTaskStart: params.retryTaskStart }
          : {}),
      },
    });
    return 'delivered';
  } catch (error) {
    if (error instanceof FastAgentParentEventDeliveryError) {
      throw error;
    }
    throw new FastAgentParentEventDeliveryError(
      error instanceof Error ? error.message : String(error),
      { cause: error, replyPosted },
    );
  } finally {
    await releaseTurnLock();
  }
}
