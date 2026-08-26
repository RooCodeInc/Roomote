import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentTaskLauncher,
  createFastAgentWebTaskLauncher,
  fastAgentConversationRepository,
  resolveApiBaseUrl,
  type FastAgentTurnAdapter,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';
import {
  asc,
  and,
  db,
  customAutomations,
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
  postSlackThreadMessageWithFooterText,
  resolveSlackReactionNames,
  SlackNotifier,
} from '@roomote/slack';
import {
  buildFastSessionReplyFooterText,
  deliverManagedThreadReplyFooter,
  getDiscordFooterlessFinalChunk,
} from '@roomote/communication';
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
import { buildCustomAutomationSlackMessage } from './manager-slack';

import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from './artifacts/raw-url';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import {
  findTeamsConversationServiceUrl,
  findTeamsWorkspaceServiceUrl,
} from '../automations/destination';
import {
  attachPendingPrReviewActionMessageWithRetirement,
  retirePrReviewActionMessagesBestEffort,
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

export type FastAgentParentEvent =
  | {
      type: 'automation_triggered';
      eventId: string;
      automationId: string;
      automationName: string;
      prompt: string;
      trigger: 'schedule' | 'manual';
      defaultTaskModel?: string;
      rootMessageId?: string;
    }
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
    }
  | {
      type: 'pull_request_conflict_detected';
      taskId: string;
      runId: number;
      taskUrl: string;
      pullRequest: FastAgentPullRequestContext;
      conflictDetectedAt: string;
      message: string;
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
      !('taskId' in params.event) ||
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
    case 'automation_triggered':
      return `fast-parent-automation:${event.eventId}`;
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
    case 'pull_request_conflict_detected':
      return `fast-parent-pr-conflict:${event.taskId}:${event.pullRequest.url}:${event.conflictDetectedAt}`;
    case 'task_settled':
      return `fast-parent-settle:${event.runId}`;
  }
}

function buildPrReviewActionNonce(event: FastAgentParentEvent): string {
  return buildSlackClientMessageId(
    `${buildEventClientMessageSeed(event)}:pr-review-action`,
  );
}

type FastAgentParentTurn = {
  userId: string;
  conversation: FastAgentConversation;
  adapter: FastAgentTurnAdapter;
};

function createFastAgentAutomationTaskLauncher(params: {
  userId: string;
  conversation: Extract<FastAgentConversation, { surface: 'automation' }>;
  event: FastAgentParentEvent;
}): LaunchFastAgentTask {
  const automationName =
    params.event.type === 'automation_triggered'
      ? params.event.automationName
      : 'Custom automation';

  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'system',
    trigger:
      params.event.type === 'automation_triggered'
        ? params.event.trigger
        : 'schedule',
    taskUrlCampaign: 'fast-automation-delegation',
    initiator: {
      kind: 'automation',
      key: 'custom_automation',
      actor: {
        externalId: params.conversation.workspaceId,
        displayName: automationName,
      },
    },
    afterKickoff: async (taskRun) => {
      await db
        .update(customAutomations)
        .set({ lastLaunchedTaskId: taskRun.taskId })
        .where(eq(customAutomations.id, params.conversation.workspaceId));
    },
    onQueueFailure: async (taskRun) => {
      await db
        .update(customAutomations)
        .set({ lastLaunchedTaskId: null })
        .where(
          and(
            eq(customAutomations.id, params.conversation.workspaceId),
            eq(customAutomations.lastLaunchedTaskId, taskRun.taskId),
          ),
        );
    },
    buildTask: ({ prompt, environmentId, model, parentSessionId }) => ({
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
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
    }),
  });
}

async function createAutomationFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'automation') {
    throw new Error('Expected an automation Fast parent conversation.');
  }

  const session = await fastAgentConversationRepository.findById({
    id: params.parent.sessionId,
    fallbackConversation,
  });
  if (!session || session.conversation.surface !== 'automation') {
    throw new FastAgentParentEventDeliveryError(
      'Fast automation parent session was not found.',
      { replyPosted: false, permanent: true },
    );
  }

  return {
    userId: session.userId,
    conversation: session.conversation,
    adapter: {
      launchTask: createFastAgentAutomationTaskLauncher({
        userId: session.userId,
        conversation: session.conversation,
        event: params.event,
      }),
      postReply: async () => {
        params.onReplyPosted();
      },
    },
  };
}

async function createWebFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'web') {
    throw new Error('Expected a web Fast parent conversation.');
  }

  const session = await fastAgentConversationRepository.findById({
    id: params.parent.sessionId,
    fallbackConversation,
  });
  if (!session || session.conversation.surface !== 'web') {
    throw new FastAgentParentEventDeliveryError(
      'Fast web parent session was not found.',
      { replyPosted: false, permanent: true },
    );
  }

  return {
    userId: session.userId,
    conversation: session.conversation,
    adapter: {
      launchTask: createFastAgentWebTaskLauncher({
        userId: session.userId,
        conversation: session.conversation,
      }),
      // Web replies are read from the canonical transcript; posting is the
      // persistence the service already performs.
      postReply: async () => {
        params.onReplyPosted();
      },
    },
  };
}

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
      postReply: async ({ message, imageArtifactIds = [], kickoff }) => {
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
                nonce: buildPrReviewActionNonce(params.event),
                taskId: params.event.taskId,
                question: params.event.suggestedActionQuestion,
                followUpPrompt: params.event.suggestedActionPrompt,
                repository: params.event.pullRequest.repository,
                prNumber: params.event.pullRequest.number,
                prUrl: params.event.pullRequest.url,
              }
            : null;

        if (params.event.type === 'automation_triggered' && !kickoff) {
          const contentBlocks = [
            { type: 'markdown' as const, text: message },
            ...images.map((image) => ({
              type: 'image' as const,
              image_url: image.url,
              alt_text: image.altText,
            })),
          ];
          const updated = await slack.updateMessage({
            channel: conversation.replyTarget.channelId,
            ts: params.event.rootMessageId ?? conversation.replyTarget.threadId,
            message: buildCustomAutomationSlackMessage({
              automationId: params.event.automationId,
              automationName: params.event.automationName,
              text: message,
              contentBlocks,
            }),
          });
          if (!updated) {
            throw new Error('Slack did not update the Fast automation root.');
          }
          params.onReplyPosted();
          return;
        }

        if (action) {
          await setPendingPrReviewAction({
            nonce: action.nonce,
            provider: 'slack',
            slackTeamId: conversation.workspaceId,
            taskId: action.taskId,
            repository: action.repository,
            prNumber: action.prNumber,
            prUrl: action.prUrl,
            channelId: conversation.replyTarget.channelId,
            threadId: conversation.replyTarget.threadId,
            followUpPrompt: action.followUpPrompt,
          });
        }
        const messageTs = await postSlackThreadMessageWithFooterText({
          slack,
          channel: conversation.replyTarget.channelId,
          threadTs: conversation.replyTarget.threadId,
          text: action ? `${message}\n${action.question}` : message,
          bodyBlocks: action
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
          footerText: buildFastSessionReplyFooterText({
            provider: 'slack',
            sessionId: params.parent.sessionId,
          }),
          clientMsgId: buildSlackClientMessageId(
            buildEventClientMessageSeed(params.event),
          ),
        });
        if (!messageTs) {
          throw new Error(
            'Slack did not return a Fast parent event timestamp.',
          );
        }
        if (action) {
          const { superseded } =
            await attachPendingPrReviewActionMessageWithRetirement(
              action.nonce,
              messageTs,
            );
          if (superseded.length > 0) {
            await retirePrReviewActionMessagesBestEffort(superseded);
          }
        }
        params.onReplyPosted();
      },
    },
  };
}

export function createFastAgentDiscordTaskLauncher(params: {
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

export function createFastAgentCommunicationTaskLauncher(params: {
  userId: string;
  conversation: Extract<
    FastAgentConversation,
    { surface: 'teams' | 'telegram' }
  >;
  serviceUrl?: string;
}): LaunchFastAgentTask {
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: params.conversation.surface,
    taskUrlCampaign: 'fast-delegation',
    buildTask: ({ prompt, environmentId, model, parentSessionId }) => ({
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
        communicationProvider: params.conversation.surface,
        communicationChannelId: params.conversation.replyTarget.channelId,
        ...(params.conversation.replyTarget.threadId
          ? {
              communicationThreadId: params.conversation.replyTarget.threadId,
              communicationMessageId: params.conversation.replyTarget.threadId,
            }
          : {}),
        ...(params.serviceUrl
          ? { communicationServiceUrl: params.serviceUrl }
          : {}),
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
    }),
  });
}

async function postDiscordFastParentMessageWithFooter(params: {
  provider: NonNullable<
    Awaited<
      ReturnType<
        typeof createDiscordCommunicationProviderFromRuntimeCredentials
      >
    >
  >;
  conversation: Extract<FastAgentConversation, { surface: 'discord' }>;
  sessionId: string;
  footerText: string;
  textWithFooter: string;
  post: () => Promise<{ messageId: string; lastTextMessageId?: string }>;
}): Promise<{ messageId: string }> {
  const channelId = params.conversation.replyTarget.channelId;
  const footerStateThreadId =
    params.conversation.replyTarget.threadId ?? 'root';

  return deliverManagedThreadReplyFooter({
    provider: 'discord',
    providerLabel: 'Discord',
    channelId,
    footerStateThreadId,
    lockKey: `discord:thread_reply_footer_lock:${channelId}:${footerStateThreadId}`,
    logRef: `fast session ${params.sessionId}`,
    logContext: 'fastAgentParentEvent',
    postReplyWithFooter: async () => {
      const result = await params.post();
      return {
        messageId: result.lastTextMessageId ?? result.messageId,
        textWithoutFooter: getDiscordFooterlessFinalChunk({
          textWithFooter: params.textWithFooter,
          footerText: params.footerText,
        }),
      };
    },
    clearPreviousFooter: async (previousFooterRecord) => {
      await params.provider.editMessage({
        channelId: params.conversation.replyTarget.threadId ?? channelId,
        messageId: previousFooterRecord.messageId,
        text: previousFooterRecord.textWithoutFooter,
      });
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
      postReply: async ({ message, imageArtifactIds = [], kickoff }) => {
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
                nonce: buildPrReviewActionNonce(params.event),
                taskId: params.event.taskId,
                question: params.event.suggestedActionQuestion,
                followUpPrompt: params.event.suggestedActionPrompt,
                repository: params.event.pullRequest.repository,
                prNumber: params.event.pullRequest.number,
                prUrl: params.event.pullRequest.url,
              }
            : null;

        if (
          params.event.type === 'automation_triggered' &&
          params.event.rootMessageId &&
          !kickoff
        ) {
          await provider.editMessage({
            channelId:
              conversation.replyTarget.threadId ??
              conversation.replyTarget.channelId,
            messageId: params.event.rootMessageId,
            text: message,
          });
          params.onReplyPosted();
          return;
        }

        if (action) {
          await setPendingPrReviewAction({
            nonce: action.nonce,
            provider: 'discord',
            taskId: action.taskId,
            repository: action.repository,
            prNumber: action.prNumber,
            prUrl: action.prUrl,
            channelId: conversation.replyTarget.channelId,
            threadId: conversation.replyTarget.threadId ?? null,
            followUpPrompt: action.followUpPrompt,
          });
        }

        const footerText = buildFastSessionReplyFooterText({
          provider: 'discord',
          sessionId: params.parent.sessionId,
        });
        const bodyText = action ? `${message}\n${action.question}` : message;
        const textWithFooter = `${bodyText}\n\n${footerText}`;
        const posted = await postDiscordFastParentMessageWithFooter({
          provider,
          conversation,
          sessionId: params.parent.sessionId,
          footerText,
          textWithFooter,
          post: () =>
            provider.postMessage({
              ...conversation.replyTarget,
              idempotencyKey: buildEventClientMessageSeed(params.event),
              text: textWithFooter,
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
            }),
        });
        if (action) {
          const { superseded } =
            await attachPendingPrReviewActionMessageWithRetirement(
              action.nonce,
              posted.messageId,
            );
          if (superseded.length > 0) {
            await retirePrReviewActionMessagesBestEffort(superseded);
          }
        }
        params.onReplyPosted();
      },
    },
  };
}

async function createTeamsFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'teams') {
    throw new Error('Expected a Teams Fast parent conversation.');
  }
  const [session, provider, conversationServiceUrl, workspaceServiceUrl] =
    await Promise.all([
      fastAgentConversationRepository.findById({
        id: params.parent.sessionId,
        fallbackConversation,
      }),
      createTeamsCommunicationProviderFromRuntimeCredentials(),
      findTeamsConversationServiceUrl(
        fallbackConversation.replyTarget.channelId,
      ),
      findTeamsWorkspaceServiceUrl(fallbackConversation.workspaceId),
    ]);
  if (!session || session.conversation.surface !== 'teams' || !provider) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent session or Teams routing credentials were not found.',
      { replyPosted: false, permanent: true },
    );
  }
  const conversation = session.conversation;
  const serviceUrl =
    conversationServiceUrl ??
    workspaceServiceUrl ??
    conversation.replyTarget.serviceUrl ??
    fallbackConversation.replyTarget.serviceUrl;
  if (!serviceUrl) {
    throw new FastAgentParentEventDeliveryError(
      'Fast Teams parent routing was not found.',
      { replyPosted: false, permanent: true },
    );
  }
  return {
    userId: session.userId,
    conversation,
    adapter: {
      launchTask: createFastAgentCommunicationTaskLauncher({
        userId: session.userId,
        conversation,
        serviceUrl,
      }),
      postReply: async ({ message, imageArtifactIds = [], kickoff }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
        });
        const text = `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'teams', sessionId: params.parent.sessionId })}`;
        if (
          params.event.type === 'automation_triggered' &&
          params.event.rootMessageId &&
          !kickoff
        ) {
          await provider.updateMessage({
            channelId: conversation.replyTarget.channelId,
            messageId: params.event.rootMessageId,
            serviceUrl,
            text,
            textFormat: 'markdown',
            images,
          });
          params.onReplyPosted();
          return { messageId: params.event.rootMessageId };
        }
        const posted = await provider.postMessage({
          channelId: conversation.replyTarget.channelId,
          serviceUrl,
          ...(conversation.replyTarget.threadId
            ? {
                threadId: conversation.replyTarget.threadId,
                replyToMessageId: conversation.replyTarget.threadId,
              }
            : {}),
          text,
          textFormat: 'markdown',
          images,
        });
        params.onReplyPosted();
        return { messageId: posted.messageId };
      },
    },
  };
}

async function createTelegramFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'telegram') {
    throw new Error('Expected a Telegram Fast parent conversation.');
  }
  const [session, provider] = await Promise.all([
    fastAgentConversationRepository.findById({
      id: params.parent.sessionId,
      fallbackConversation,
    }),
    createTelegramCommunicationProviderFromRuntimeCredentials(),
  ]);
  if (!session || session.conversation.surface !== 'telegram' || !provider) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent session or Telegram credentials were not found.',
      { replyPosted: false, permanent: true },
    );
  }
  const conversation = session.conversation;
  return {
    userId: session.userId,
    conversation,
    adapter: {
      launchTask: createFastAgentCommunicationTaskLauncher({
        userId: session.userId,
        conversation,
      }),
      postReply: async ({ message, imageArtifactIds = [] }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
        });
        const posted = await provider.postMessage({
          channelId: conversation.replyTarget.channelId,
          ...(conversation.replyTarget.threadId
            ? { threadId: conversation.replyTarget.threadId }
            : {}),
          text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'telegram', sessionId: params.parent.sessionId })}`,
          textFormat: 'markdown',
          images,
        });
        params.onReplyPosted();
        return { messageId: posted.messageId };
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
    case 'teams':
      return createTeamsFastAgentParentTurn(params);
    case 'telegram':
      return createTelegramFastAgentParentTurn(params);
    case 'automation':
      return createAutomationFastAgentParentTurn(params);
    case 'web':
      return createWebFastAgentParentTurn(params);
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
    const defaultTaskModel =
      params.event.type === 'automation_triggered'
        ? params.event.defaultTaskModel
        : undefined;
    const launchTask = defaultTaskModel
      ? (input: Parameters<LaunchFastAgentTask>[0]) =>
          parentTurn.adapter.launchTask({
            ...input,
            model: input.model ?? defaultTaskModel,
          })
      : parentTurn.adapter.launchTask;
    // The same base URL must reach both the config resolver and the broker:
    // the broker only injects its auth header on deployment-proxy URLs whose
    // origin matches its own apiBaseUrl, so a mismatched pair silently drops
    // every deployment MCP server from parent-event turns.
    const apiBaseUrl = resolveApiBaseUrl() ?? undefined;
    await answerFastAgentQuestion({
      question: `<platform_event>${JSON.stringify(params.event)}</platform_event>`,
      userId: parentTurn.userId,
      conversation: parentTurn.conversation,
      currentMessageId: buildEventClientMessageSeed(params.event),
      apiBaseUrl,
      signal: releaseTurnLock.signal,
      turnSource: 'platform_event',
      platformEventHandling:
        params.event.type === 'pull_request_feedback' ||
        params.event.type === 'pull_request_conflict_detected'
          ? 'present_only'
          : 'default',
      platformEventVisibility:
        params.event.type === 'pull_request_feedback' ||
        params.event.type === 'pull_request_conflict_detected' ||
        params.event.type === 'automation_triggered'
          ? 'required'
          : 'optional',
      platformEventKind:
        params.event.type === 'automation_triggered'
          ? 'automation'
          : 'delegated_task',
      adapter: {
        ...parentTurn.adapter,
        launchTask,
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId: parentTurn.userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
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
