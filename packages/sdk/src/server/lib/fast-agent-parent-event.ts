import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentTaskLauncher,
  createFastAgentWebTaskLauncher,
  fastAgentConversationRepository,
  resolveApiBaseUrl,
  type FastAgentConversationRecord,
  type FastAgentTurnLockHandle,
  type FastAgentReplyHandle,
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
  getCustomAutomationById,
  inArray,
  slackInstallations,
  taskArtifacts,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import { Env, getArtifactSigningKey } from '@roomote/env';
import {
  acquireSlackFastRootBindingLock,
  buildSlackPrReviewActionBlocks,
  createFastAgentSlackLiveTaskLauncher,
  createFastAgentSlackSessionActivity,
  postSlackThreadMessageWithFooterText,
  resolveSlackReactionNames,
  SlackNotifier,
} from '@roomote/slack';
import {
  buildFastSessionReplyFooterText,
  deliverManagedThreadReplyFooter,
  getDiscordFooterlessFinalChunk,
  resolveFastSessionReplyFooterContext,
  type FastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  buildPrReviewActionCallbackData,
  PR_REVIEW_ACTION_LABELS,
  TaskPayloadKind,
  exitedRunStatuses,
  type FastAgentConversation,
  type FastAgentHumanFollowUpEvent,
  type FastAgentSourceControlReplyTarget,
  type FastAgentParent,
  type PullRequestStatus,
  type RunStatus,
  type TaskRunErrorCode,
  type SourceControlProvider,
  type StandardTask,
  isFastAgentSourceControlConversation,
} from '@roomote/types';

import { resolveUserMcpServerConfigs } from '../routers/mcp-connections';
import {
  buildLinearFastReplyMessageId,
  createFastAgentLinearTaskLauncher,
  resolveLinearFastSessionClient,
} from './linear-fast-session';
import {
  buildSourceControlFastAdapter,
  buildSourceControlFastConversation,
  buildSourceControlFastDelivery,
  buildSourceControlReplyQuote,
  type SourceControlFastDiscussion,
} from './source-control-fast-delivery';
import { buildCustomAutomationSlackMessage } from './manager-slack';
import {
  appendFastAutomationSuggestionInstruction,
  postFastAutomationSuggestionsToDiscord,
  postFastAutomationSuggestionsToSlack,
  postFastAutomationSuggestionsToTeams,
  postFastAutomationSuggestionsToTelegram,
} from './fast-automation-suggestions';

import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from './artifacts/raw-url';
import {
  resolveFastAgentSessionImages,
  type FastAgentReplyImage,
} from './fast-agent-session-images';
import { buildFastAgentArtifactCreator } from './artifacts/fast-agent-artifact-creator';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { findTeamsConversationRoute } from '../automations/destination';
import { recordFastAgentConversationMessageBestEffort } from './fast-agent-provider-message';
import {
  createDiscordFastReplyReplacer,
  createSlackFastReplyReplacer,
  createTeamsFastReplyReplacer,
  createTelegramFastReplyReplacer,
} from './fast-agent-reply-replacement';
import {
  attachPendingPrReviewActionMessageWithRetirement,
  retirePrReviewActionMessagesBestEffort,
  setPendingPrReviewAction,
} from './task-runs/pr-review-action';

const EXITED_RUN_STATUSES = new Set<RunStatus>(exitedRunStatuses);

function requireFastAgentActorUserId(
  session: FastAgentConversationRecord,
  actorUserId?: string,
): string {
  const userId = actorUserId ?? session.userId;
  if (!userId) {
    throw new FastAgentParentEventDeliveryError(
      'Automation-owned Fast sessions require a human actor for this turn.',
      { replyPosted: false, permanent: true },
    );
  }
  return userId;
}

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
  targetBranch?: string | null;
  status: PullRequestStatus | null;
};

export type FastAgentParentEvent =
  | FastAgentHumanFollowUpEvent
  | {
      type: 'automation_triggered';
      eventId: string;
      automationId: string;
      automationName: string;
      launchClaimedAt?: string;
      prompt: string;
      trigger: 'schedule' | 'manual';
      /** Environment the automation was configured for; `all` for every repository. */
      preferredEnvironmentId?: string;
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
      customAutomationId?: string;
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
      reviewActionDeliveryId?: string;
      reviewTaskId?: string;
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

async function buildSelectedImages(params: {
  artifactIds: string[];
  event: FastAgentParentEvent;
  sessionId: string;
}): Promise<FastAgentReplyImage[]> {
  const artifactIds = [...new Set(params.artifactIds)];
  if (artifactIds.length === 0) {
    return [];
  }

  if (params.event.type === 'human_follow_up') {
    return resolveFastAgentSessionImages({
      artifactIds,
      sessionId: params.sessionId,
    });
  }

  const eventIds = new Set(
    params.event.type === 'artifact_published'
      ? [params.event.artifact.id]
      : params.event.type === 'child_message'
        ? (params.event.imageArtifactIds ?? [])
        : [],
  );
  if (eventIds.size === 0) {
    return [];
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
    const belongsToCurrentEvent =
      artifact &&
      eventIds.has(id) &&
      'taskId' in params.event &&
      artifact.taskId === params.event.taskId &&
      artifact.runId === params.event.runId;
    if (
      !artifact ||
      !artifact.uploaded ||
      !belongsToCurrentEvent ||
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

export function buildEventClientMessageSeed(
  event: FastAgentParentEvent,
): string {
  switch (event.type) {
    case 'human_follow_up':
      return `fast-parent-human-follow-up:${event.eventId}`;
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

/**
 * Events whose closeout is a custom automation's report: the run's own turn,
 * and the settle of a task that turn delegated. Both may carry launchable
 * suggestions.
 */
function isFastAutomationReportEvent(
  event: FastAgentParentEvent,
): event is Extract<
  FastAgentParentEvent,
  { type: 'automation_triggered' | 'task_settled' }
> {
  return (
    event.type === 'automation_triggered' ||
    (event.type === 'task_settled' && Boolean(event.customAutomationId))
  );
}

/** Groups a report's suggestion cards; unique per run occurrence. */
function buildFastAutomationSuggestionEventId(
  event: Extract<
    FastAgentParentEvent,
    { type: 'automation_triggered' | 'task_settled' }
  >,
): string {
  return event.type === 'automation_triggered'
    ? event.eventId
    : `${event.customAutomationId}:task:${event.taskId}`;
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

type FastAgentParentTurnParams = {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  actorUserId?: string;
  onReplyPosted: () => void;
  footerContext: FastSessionReplyFooterContext;
};

/** The custom automation a Fast conversation is running for, when known. */
type FastAutomationLaunchContext = {
  automationId: string;
  automationName: string;
  trigger: 'schedule' | 'manual';
};

const AUTOMATION_OCCURRENCE_ID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/iu;

/**
 * Custom automation conversations on Slack, Teams, Telegram, and Discord DMs
 * are keyed by the run occurrence, `<automationId>:<claimedAt>`. A Discord
 * channel run is keyed by its thread instead, so only the event can name
 * the automation there.
 */
function parseCustomAutomationIdFromConversationId(
  conversationId: string,
): string | undefined {
  return AUTOMATION_OCCURRENCE_ID_PATTERN.exec(conversationId)?.[1];
}

async function resolveFastAutomationLaunchContext(params: {
  event: FastAgentParentEvent;
  conversation: FastAgentConversation;
}): Promise<FastAutomationLaunchContext | null> {
  if (params.event.type === 'automation_triggered') {
    return {
      automationId: params.event.automationId,
      automationName: params.event.automationName,
      trigger: params.event.trigger,
    };
  }
  const automationId =
    (params.event.type === 'task_settled'
      ? params.event.customAutomationId
      : undefined) ??
    parseCustomAutomationIdFromConversationId(
      params.conversation.conversationId,
    );
  if (!automationId) {
    return null;
  }
  const automation = await getCustomAutomationById(automationId);
  return {
    automationId,
    automationName: automation?.name ?? 'Custom automation',
    trigger: 'schedule',
  };
}

/**
 * Launch options that make a delegated task the automation's own work: it
 * is attributed to the automation (acting as the run's user), carries the
 * automation id so its settle is a report, and updates the automation's
 * last-launched task.
 */
function buildFastAutomationLaunchOptions(params: {
  userId: string;
  automation: FastAutomationLaunchContext;
}): Pick<
  Parameters<typeof createFastAgentTaskLauncher>[0],
  'initiator' | 'trigger' | 'afterKickoff' | 'onQueueFailure'
> & { payload: { customAutomationId: string } } {
  const { automationId } = params.automation;
  return {
    trigger: params.automation.trigger,
    initiator: {
      kind: 'automation',
      key: 'custom_automation',
      actor: {
        externalId: automationId,
        displayName: params.automation.automationName,
      },
      actingUserId: params.userId,
    },
    afterKickoff: async (taskRun) => {
      await db
        .update(customAutomations)
        .set({ lastLaunchedTaskId: taskRun.taskId })
        .where(eq(customAutomations.id, automationId));
    },
    onQueueFailure: async (taskRun) => {
      await db
        .update(customAutomations)
        .set({ lastLaunchedTaskId: null })
        .where(
          and(
            eq(customAutomations.id, automationId),
            eq(customAutomations.lastLaunchedTaskId, taskRun.taskId),
          ),
        );
    },
    payload: { customAutomationId: automationId },
  };
}

function createFastAgentAutomationTaskLauncher(params: {
  userId: string;
  conversation: FastAgentConversation;
  automationId: string;
  automationName: string;
  event: FastAgentParentEvent;
}): LaunchFastAgentTask {
  const { payload, ...launchOptions } = buildFastAutomationLaunchOptions({
    userId: params.userId,
    automation: {
      automationId: params.automationId,
      automationName: params.automationName,
      trigger:
        params.event.type === 'automation_triggered'
          ? params.event.trigger
          : 'schedule',
    },
  });
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'system',
    taskUrlCampaign: 'fast-automation-delegation',
    ...launchOptions,
    buildTask: ({
      prompt,
      environmentId,
      model,
      reasoningEffort,
      parentSessionId,
    }) => ({
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
        ...payload,
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
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    }),
  });
}

async function createAutomationFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  actorUserId?: string;
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
  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);

  return {
    userId: actorUserId,
    conversation: session.conversation,
    adapter: {
      launchTask: createFastAgentAutomationTaskLauncher({
        userId: actorUserId,
        conversation: session.conversation,
        automationId: session.conversation.workspaceId,
        automationName:
          params.event.type === 'automation_triggered'
            ? params.event.automationName
            : 'Custom automation',
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
  actorUserId?: string;
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
  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);

  return {
    userId: actorUserId,
    conversation: session.conversation,
    adapter: {
      launchTask: createFastAgentWebTaskLauncher({
        userId: actorUserId,
      }),
      // Web replies are read from the canonical transcript; posting is the
      // persistence the service already performs.
      postReply: async () => {
        params.onReplyPosted();
      },
    },
  };
}

async function createSlackFastAgentParentTurn(
  params: FastAgentParentTurnParams,
): Promise<FastAgentParentTurn> {
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

  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);
  const conversation = session.conversation;
  const slack = new SlackNotifier(installation.botAccessToken);
  const threadId = conversation.replyTarget.threadId;
  const pendingAutomationRoot = !threadId;
  const customAutomationId =
    params.event.type === 'automation_triggered'
      ? params.event.automationId
      : params.event.type === 'task_settled'
        ? params.event.customAutomationId
        : pendingAutomationRoot
          ? conversation.conversationId.split(':', 1)[0]
          : undefined;
  const customAutomation = customAutomationId
    ? await getCustomAutomationById(customAutomationId)
    : null;
  const automationName =
    params.event.type === 'automation_triggered'
      ? params.event.automationName
      : (customAutomation?.name ?? 'Custom automation');

  if (
    conversation.replyTarget.threadId &&
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
    userId: actorUserId,
    conversation,
    adapter: {
      ...(pendingAutomationRoot
        ? {}
        : {
            activity: createFastAgentSlackSessionActivity({
              slack,
              workspaceId: conversation.workspaceId,
              channel: conversation.replyTarget.channelId,
              threadTs: threadId!,
              title: session.title,
              resolveTitle: async () =>
                (
                  await fastAgentConversationRepository.findById({
                    id: session.id,
                  })
                )?.title,
            }),
          }),
      launchTask: pendingAutomationRoot
        ? createFastAgentAutomationTaskLauncher({
            userId: actorUserId,
            conversation,
            automationId: customAutomationId ?? conversation.conversationId,
            automationName,
            event: params.event,
          })
        : createFastAgentSlackLiveTaskLauncher({
            slack,
            userId: actorUserId,
            teamId: conversation.workspaceId,
            ...(installation.teamDomain
              ? { teamDomain: installation.teamDomain }
              : {}),
            channelId: conversation.replyTarget.channelId,
            threadTs: threadId!,
            // A bound automation thread keeps delegating as the automation,
            // so later launches settle as its reports too.
            ...(customAutomationId
              ? {
                  customAutomationId,
                  initiator: {
                    kind: 'automation',
                    key: 'custom_automation',
                    actor: {
                      externalId: customAutomationId,
                      displayName: automationName,
                    },
                    actingUserId: actorUserId,
                  },
                }
              : {}),
          }),
      // A resumed turn edits the retry notice its predecessor posted, so the
      // queue-side adapter needs the same in-place replacement as the
      // webhook handler.
      ...(pendingAutomationRoot
        ? {}
        : {
            replaceReply: createSlackFastReplyReplacer({
              slack,
              conversation,
              channelId: conversation.replyTarget.channelId,
              threadTs: threadId!,
              sessionId: session.id,
              footerContext: params.footerContext,
            }),
          }),
      postReply: async ({
        message,
        imageArtifactIds = [],
        suggestions = [],
        kickoff,
        purpose,
      }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
          sessionId: params.parent.sessionId,
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

        const reportMessage =
          isFastAutomationReportEvent(params.event) && !kickoff
            ? appendFastAutomationSuggestionInstruction(
                message,
                'slack',
                suggestions.length > 0,
              )
            : message;
        const contentBlocks = [
          { type: 'markdown' as const, text: reportMessage },
          ...images.map((image) => ({
            type: 'image' as const,
            image_url: image.url,
            alt_text: image.altText,
          })),
        ];
        if (pendingAutomationRoot) {
          const shouldPostResult =
            !kickoff && (purpose === 'closeout' || purpose === 'clarification');
          if (!shouldPostResult || !customAutomationId) {
            return;
          }

          const releaseRootBindingLock = await acquireSlackFastRootBindingLock({
            teamId: conversation.workspaceId,
            channelId: conversation.replyTarget.channelId,
          });
          let messageTs: string | undefined;
          try {
            messageTs = await slack.postMessage({
              channel: conversation.replyTarget.channelId,
              ...buildCustomAutomationSlackMessage({
                automationId: customAutomationId,
                automationName,
                text: reportMessage,
                contentBlocks,
                sessionId: params.parent.sessionId,
                ...(params.event.type === 'task_settled'
                  ? { taskUrl: params.event.taskUrl }
                  : {}),
              }),
              unfurl_links: false,
              unfurl_media: false,
              client_msg_id: buildSlackClientMessageId(
                `fast-automation-root:${conversation.conversationId}`,
              ),
            });
            if (!messageTs) {
              throw new Error(
                'Slack did not create the Fast automation result.',
              );
            }
            params.onReplyPosted();
            await fastAgentConversationRepository.getOrCreate({
              userId: actorUserId,
              conversation: {
                ...conversation,
                replyTarget: {
                  ...conversation.replyTarget,
                  threadId: messageTs,
                },
              },
            });
            await recordFastAgentConversationMessageBestEffort({
              sessionId: session.id,
              conversation: {
                ...conversation,
                replyTarget: {
                  ...conversation.replyTarget,
                  threadId: messageTs,
                },
              },
              messageId: messageTs,
            });
          } finally {
            await releaseRootBindingLock().catch(() => {});
          }
          if (
            isFastAutomationReportEvent(params.event) &&
            suggestions.length > 0
          ) {
            await postFastAutomationSuggestionsToSlack({
              slack,
              channelId: conversation.replyTarget.channelId,
              threadTs: messageTs,
              eventId: buildFastAutomationSuggestionEventId(params.event),
              createdByUserId: actorUserId,
              suggestions,
            });
          }
          return { messageId: messageTs };
        }

        if (
          !kickoff &&
          (params.event.type === 'automation_triggered' ||
            (params.event.type === 'task_settled' && customAutomationId))
        ) {
          const rootMessageId =
            params.event.type === 'automation_triggered'
              ? (params.event.rootMessageId ?? threadId!)
              : threadId!;
          const updated = await slack.updateMessage({
            channel: conversation.replyTarget.channelId,
            ts: rootMessageId,
            message: buildCustomAutomationSlackMessage({
              automationId: customAutomationId!,
              automationName,
              text: reportMessage,
              contentBlocks,
              sessionId: params.parent.sessionId,
              ...(params.event.type === 'task_settled'
                ? { taskUrl: params.event.taskUrl }
                : {}),
            }),
          });
          if (!updated) {
            throw new Error('Slack did not update the Fast automation root.');
          }
          if (
            isFastAutomationReportEvent(params.event) &&
            suggestions.length > 0
          ) {
            await postFastAutomationSuggestionsToSlack({
              slack,
              channelId: conversation.replyTarget.channelId,
              threadTs: rootMessageId,
              eventId: buildFastAutomationSuggestionEventId(params.event),
              createdByUserId: actorUserId,
              suggestions,
            });
          }
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: rootMessageId,
          });
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
            threadId: threadId ?? null,
            followUpPrompt: action.followUpPrompt,
          });
        }
        const messageTs = await postSlackThreadMessageWithFooterText({
          slack,
          channel: conversation.replyTarget.channelId,
          threadTs: threadId!,
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
            ...params.footerContext,
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
        await recordFastAgentConversationMessageBestEffort({
          sessionId: session.id,
          conversation,
          messageId: messageTs,
        });
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
        // The handle lets the turn edit this message later (a retry notice
        // becoming the answer), including from a run the queue resumes.
        return { messageId: messageTs };
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
  /** Set when the conversation is a custom automation run. */
  automation?: FastAutomationLaunchContext | null;
}): LaunchFastAgentTask {
  const { payload: automationPayload, ...automationLaunchOptions } =
    params.automation
      ? buildFastAutomationLaunchOptions({
          userId: params.userId,
          automation: params.automation,
        })
      : { payload: {} };
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'discord',
    taskUrlCampaign: 'fast-delegation',
    ...automationLaunchOptions,
    buildTask: async ({
      prompt,
      environmentId,
      model,
      reasoningEffort,
      parentSessionId,
    }) => {
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
          ...automationPayload,
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
          ...(reasoningEffort ? { reasoningEffort } : {}),
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
  /** Set when the conversation is a custom automation run. */
  automation?: FastAutomationLaunchContext | null;
}): LaunchFastAgentTask {
  const { payload: automationPayload, ...automationLaunchOptions } =
    params.automation
      ? buildFastAutomationLaunchOptions({
          userId: params.userId,
          automation: params.automation,
        })
      : { payload: {} };
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: params.conversation.surface,
    taskUrlCampaign: 'fast-delegation',
    ...automationLaunchOptions,
    buildTask: ({
      prompt,
      environmentId,
      model,
      reasoningEffort,
      parentSessionId,
    }) => ({
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
        ...automationPayload,
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
        ...(reasoningEffort ? { reasoningEffort } : {}),
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

async function createDiscordFastAgentParentTurn(
  params: FastAgentParentTurnParams,
): Promise<FastAgentParentTurn> {
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

  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);
  const conversation = session.conversation;
  const automation = await resolveFastAutomationLaunchContext({
    event: params.event,
    conversation,
  });
  const adapter: FastAgentTurnAdapter = {
    launchTask: createFastAgentDiscordTaskLauncher({
      provider,
      userId: actorUserId,
      conversation,
      automation,
    }),
    postReply: async ({
      message,
      imageArtifactIds = [],
      suggestions = [],
      kickoff,
    }) => {
      const images = await buildSelectedImages({
        artifactIds: imageArtifactIds,
        event: params.event,
        sessionId: params.parent.sessionId,
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
        const reportMessage = appendFastAutomationSuggestionInstruction(
          message,
          'discord',
          suggestions.length > 0,
        );
        let reportMessageId = params.event.rootMessageId;
        if (params.event.rootMessageId) {
          await provider.editMessage({
            channelId:
              conversation.replyTarget.threadId ??
              conversation.replyTarget.channelId,
            messageId: params.event.rootMessageId,
            text: reportMessage,
          });
        } else {
          const posted = await provider.postMessage({
            ...conversation.replyTarget,
            idempotencyKey: buildEventClientMessageSeed(params.event),
            text: reportMessage,
            textFormat: 'markdown',
            images,
          });
          reportMessageId = posted.messageId;
        }
        if (!reportMessageId) {
          throw new Error(
            'Discord did not return a Fast automation report message id.',
          );
        }
        await recordFastAgentConversationMessageBestEffort({
          sessionId: session.id,
          conversation,
          messageId: reportMessageId,
        });
        if (suggestions.length > 0) {
          await postFastAutomationSuggestionsToDiscord({
            provider,
            channelId: conversation.replyTarget.channelId,
            ...(conversation.replyTarget.threadId
              ? { threadId: conversation.replyTarget.threadId }
              : {}),
            eventId: params.event.eventId,
            createdByUserId: actorUserId,
            suggestions,
          });
        }
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
        ...params.footerContext,
      });
      const settleReport =
        isFastAutomationReportEvent(params.event) && !kickoff
          ? params.event
          : null;
      const reportMessage = settleReport
        ? appendFastAutomationSuggestionInstruction(
            message,
            'discord',
            suggestions.length > 0,
          )
        : message;
      const bodyText = action
        ? `${reportMessage}\n${action.question}`
        : reportMessage;
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
                        text: PR_REVIEW_ACTION_LABELS.yes,
                        callbackData: buildPrReviewActionCallbackData(
                          'yes',
                          action.nonce,
                        ),
                      },
                      {
                        text: PR_REVIEW_ACTION_LABELS.auto,
                        callbackData: buildPrReviewActionCallbackData(
                          'auto',
                          action.nonce,
                        ),
                      },
                      {
                        text: PR_REVIEW_ACTION_LABELS.dismiss,
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
      await recordFastAgentConversationMessageBestEffort({
        sessionId: session.id,
        conversation,
        messageId: posted.messageId,
      });
      if (settleReport && suggestions.length > 0) {
        await postFastAutomationSuggestionsToDiscord({
          provider,
          channelId: conversation.replyTarget.channelId,
          ...(conversation.replyTarget.threadId
            ? { threadId: conversation.replyTarget.threadId }
            : {}),
          eventId: buildFastAutomationSuggestionEventId(settleReport),
          createdByUserId: actorUserId,
          suggestions,
        });
      }
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
      // The handle lets the turn edit this message later (a retry notice
      // becoming the answer), including from a run the queue resumes.
      return { messageId: posted.messageId };
    },
  };
  // A resumed turn edits the retry notice its predecessor posted; an
  // oversized replacement falls back to a fresh reply through this adapter.
  adapter.replaceReply = createDiscordFastReplyReplacer({
    provider,
    conversation,
    channelId: conversation.replyTarget.channelId,
    threadId: conversation.replyTarget.threadId,
    sessionId: session.id,
    footerContext: params.footerContext,
    postReplacement: (text) =>
      adapter.postReply({ purpose: 'closeout', message: text }),
  });
  return { userId: actorUserId, conversation, adapter };
}

async function createTeamsFastAgentParentTurn(
  params: FastAgentParentTurnParams,
): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'teams') {
    throw new Error('Expected a Teams Fast parent conversation.');
  }
  const [session, provider] = await Promise.all([
    fastAgentConversationRepository.findById({
      id: params.parent.sessionId,
      fallbackConversation,
    }),
    createTeamsCommunicationProviderFromRuntimeCredentials(),
  ]);
  if (!session || session.conversation.surface !== 'teams' || !provider) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent session or Teams routing credentials were not found.',
      { replyPosted: false, permanent: true },
    );
  }
  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);
  const conversation = session.conversation;
  const route = await findTeamsConversationRoute(
    conversation.replyTarget.channelId,
    conversation.workspaceId,
  );
  const persistedDirectMessageServiceUrl = conversation.replyTarget.threadId
    ? undefined
    : conversation.replyTarget.serviceUrl;
  const serviceUrl = route?.serviceUrl ?? persistedDirectMessageServiceUrl;
  if (!serviceUrl) {
    throw new FastAgentParentEventDeliveryError(
      'Fast Teams parent routing was not found.',
      { replyPosted: false, permanent: true },
    );
  }
  return {
    userId: actorUserId,
    conversation,
    adapter: {
      launchTask: createFastAgentCommunicationTaskLauncher({
        userId: actorUserId,
        conversation,
        serviceUrl,
        automation: await resolveFastAutomationLaunchContext({
          event: params.event,
          conversation,
        }),
      }),
      replaceReply: createTeamsFastReplyReplacer({
        provider,
        conversation,
        channelId: conversation.replyTarget.channelId,
        serviceUrl,
        sessionId: session.id,
        footerContext: params.footerContext,
      }),
      postReply: async ({
        message,
        imageArtifactIds = [],
        suggestions = [],
        kickoff,
      }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
          sessionId: params.parent.sessionId,
        });
        const reportMessage =
          isFastAutomationReportEvent(params.event) && !kickoff
            ? appendFastAutomationSuggestionInstruction(
                message,
                'teams',
                suggestions.length > 0,
              )
            : message;
        const text = `${reportMessage}\n\n${buildFastSessionReplyFooterText({ provider: 'teams', sessionId: params.parent.sessionId, ...params.footerContext })}`;
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
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: params.event.rootMessageId,
          });
          if (suggestions.length > 0) {
            await postFastAutomationSuggestionsToTeams({
              provider,
              channelId: conversation.replyTarget.channelId,
              serviceUrl,
              ...(conversation.replyTarget.threadId
                ? { threadId: conversation.replyTarget.threadId }
                : {}),
              eventId: params.event.eventId,
              createdByUserId: actorUserId,
              suggestions,
            });
          }
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
        if (
          isFastAutomationReportEvent(params.event) &&
          !kickoff &&
          suggestions.length > 0
        ) {
          await postFastAutomationSuggestionsToTeams({
            provider,
            channelId: conversation.replyTarget.channelId,
            serviceUrl,
            ...(conversation.replyTarget.threadId
              ? { threadId: conversation.replyTarget.threadId }
              : {}),
            eventId: buildFastAutomationSuggestionEventId(params.event),
            createdByUserId: actorUserId,
            suggestions,
          });
        }
        await recordFastAgentConversationMessageBestEffort({
          sessionId: session.id,
          conversation,
          messageId: posted.messageId,
        });
        params.onReplyPosted();
        return { messageId: posted.messageId };
      },
    },
  };
}

async function createTelegramFastAgentParentTurn(
  params: FastAgentParentTurnParams,
): Promise<FastAgentParentTurn> {
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
  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);
  const conversation = session.conversation;
  return {
    userId: actorUserId,
    conversation,
    adapter: {
      launchTask: createFastAgentCommunicationTaskLauncher({
        userId: actorUserId,
        conversation,
        automation: await resolveFastAutomationLaunchContext({
          event: params.event,
          conversation,
        }),
      }),
      replaceReply: createTelegramFastReplyReplacer({
        provider,
        conversation,
        channelId: conversation.replyTarget.channelId,
        sessionId: session.id,
        footerContext: params.footerContext,
      }),
      postReply: async ({
        message,
        imageArtifactIds = [],
        suggestions = [],
        kickoff,
      }) => {
        const images = await buildSelectedImages({
          artifactIds: imageArtifactIds,
          event: params.event,
          sessionId: params.parent.sessionId,
        });
        const reportMessage =
          isFastAutomationReportEvent(params.event) && !kickoff
            ? appendFastAutomationSuggestionInstruction(
                message,
                'telegram',
                suggestions.length > 0,
              )
            : message;
        const posted = await provider.postMessage({
          channelId: conversation.replyTarget.channelId,
          ...(conversation.replyTarget.threadId
            ? { threadId: conversation.replyTarget.threadId }
            : {}),
          text: `${reportMessage}\n\n${buildFastSessionReplyFooterText({ provider: 'telegram', sessionId: params.parent.sessionId, ...params.footerContext })}`,
          textFormat: 'markdown',
          images,
        });
        await recordFastAgentConversationMessageBestEffort({
          sessionId: session.id,
          conversation,
          messageId: posted.lastTextMessageId ?? posted.messageId,
        });
        if (
          isFastAutomationReportEvent(params.event) &&
          !kickoff &&
          suggestions.length > 0
        ) {
          await postFastAutomationSuggestionsToTelegram({
            provider,
            channelId: conversation.replyTarget.channelId,
            ...(conversation.replyTarget.threadId
              ? { threadId: conversation.replyTarget.threadId }
              : {}),
            eventId: buildFastAutomationSuggestionEventId(params.event),
            createdByUserId: actorUserId,
            suggestions,
          });
        }
        params.onReplyPosted();
        return { messageId: posted.messageId };
      },
    },
  };
}

/**
 * A Linear agent session has no thread to post into: child outcomes land in
 * the session as agent responses, the same way the Session's own replies do.
 */
async function createLinearFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  actorUserId?: string;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (fallbackConversation.surface !== 'linear') {
    throw new Error('Expected a Linear Fast parent conversation.');
  }
  const [session, linear] = await Promise.all([
    fastAgentConversationRepository.findById({
      id: params.parent.sessionId,
      fallbackConversation,
    }),
    resolveLinearFastSessionClient(fallbackConversation.workspaceId),
  ]);
  if (!session || session.conversation.surface !== 'linear' || !linear) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent session or Linear credentials were not found.',
      { replyPosted: false, permanent: true },
    );
  }
  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);
  const conversation = session.conversation;
  const agentSessionId = conversation.replyTarget.channelId;
  return {
    userId: actorUserId,
    conversation,
    adapter: {
      launchTask: createFastAgentLinearTaskLauncher({
        userId: actorUserId,
        conversation,
        resolveIssue: () => linear.getAgentSessionIssue(agentSessionId),
      }),
      postReply: async ({ message }) => {
        const result = await linear.emitResponse(agentSessionId, message);
        if (!result.success) {
          throw new Error(
            result.error ?? 'Linear did not accept the agent response.',
          );
        }
        params.onReplyPosted();
        return { messageId: buildLinearFastReplyMessageId() };
      },
    },
  };
}

/**
 * A pull request or issue discussion: child outcomes post as comments the
 * same way the Session's own replies do.
 */
async function createSourceControlFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  actorUserId?: string;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const fallbackConversation = params.parent.conversation;
  if (!isFastAgentSourceControlConversation(fallbackConversation)) {
    throw new Error('Expected a source-control Fast parent conversation.');
  }
  const session = await fastAgentConversationRepository.findById({
    id: params.parent.sessionId,
    fallbackConversation,
  });
  const conversation = session?.conversation;
  if (
    !session ||
    !conversation ||
    !isFastAgentSourceControlConversation(conversation)
  ) {
    throw new FastAgentParentEventDeliveryError(
      'Fast source-control parent session was not found.',
      { replyPosted: false, permanent: true },
    );
  }
  const delivery = await buildSourceControlFastDelivery(conversation);
  if (!delivery) {
    throw new FastAgentParentEventDeliveryError(
      'The repository for this Fast parent session is not connected.',
      { replyPosted: false, permanent: true },
    );
  }
  const actorUserId = requireFastAgentActorUserId(session, params.actorUserId);
  return {
    userId: actorUserId,
    conversation,
    adapter: buildSourceControlFastAdapter({
      conversation,
      delivery,
      userId: actorUserId,
      sessionId: session.id,
      // Mentions reach this turn through the durable queue, so the quote of
      // the answered comment has to come from the queued event itself.
      quote:
        params.event.type === 'human_follow_up'
          ? buildSourceControlReplyQuote({ text: params.event.question })
          : null,
      continuesThreadComment: params.event.type !== 'human_follow_up',
      onReplyPosted: params.onReplyPosted,
    }),
  };
}

/**
 * Attribution line for the home surface when a human turn arrived on a
 * source-control discussion: who wrote it and where, quoted the way a web
 * reply is quoted into a Slack thread.
 */
function buildSourceControlOriginAttribution(
  event: FastAgentHumanFollowUpEvent,
  target: FastAgentSourceControlReplyTarget,
): string {
  const label = `${target.repositoryFullName}#${target.number}`;
  const where = target.url ? `[${label}](${target.url})` : label;
  const who = event.senderDisplayName?.trim() || 'Someone';
  const quoted = event.question
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `> **${who}** on ${where}:\n${quoted}`;
}

/**
 * A human turn that arrived on a source-control discussion this Session owns
 * through a task (a mention on the pull request a Slack Session's task opened)
 * answers in both places: the Session's home surface as usual, and the
 * discussion the message came from. Delegated work targets the discussion's
 * branch while staying attached to this Session.
 */
async function withSourceControlReplyTarget(
  turn: FastAgentParentTurn,
  params: {
    parent: FastAgentParent;
    event: FastAgentHumanFollowUpEvent;
    onReplyPosted: () => void;
  },
): Promise<FastAgentParentTurn> {
  const target = params.event.sourceControlReplyTarget;
  if (!target) {
    return turn;
  }
  const discussion: SourceControlFastDiscussion = {
    provider: target.provider,
    host: target.host,
    repositoryFullName: target.repositoryFullName,
    kind: target.kind,
    number: target.number,
    ...(target.reviewCommentId
      ? { reviewCommentId: target.reviewCommentId }
      : {}),
    ...(target.replyCommentId ? { replyCommentId: target.replyCommentId } : {}),
  };
  const conversation = buildSourceControlFastConversation(discussion);
  // The Session's own discussion: the home adapter already posts there.
  if (
    isFastAgentSourceControlConversation(turn.conversation) &&
    turn.conversation.workspaceId === conversation.workspaceId &&
    turn.conversation.conversationId === conversation.conversationId
  ) {
    return turn;
  }
  const delivery = await buildSourceControlFastDelivery(conversation);
  if (!delivery) {
    console.warn(
      `[Fast Agent] The repository for ${target.repositoryFullName} is not connected; answering only on the Session's home surface.`,
    );
    return turn;
  }
  const discussionAdapter = buildSourceControlFastAdapter({
    conversation,
    delivery,
    userId: turn.userId,
    sessionId: params.parent.sessionId,
    parentConversation: turn.conversation,
    quote: buildSourceControlReplyQuote({ text: params.event.question }),
    onReplyPosted: params.onReplyPosted,
  });
  const attribution = buildSourceControlOriginAttribution(params.event, target);
  let attributionPending = true;
  const discussionLabel = `${target.repositoryFullName}#${target.number}`;
  const postOnDiscussion = async (
    message: string,
  ): Promise<FastAgentReplyHandle | null> => {
    try {
      return await discussionAdapter.postReply({ message });
    } catch (error) {
      console.warn(
        `[Fast Agent] Failed to post the Session's reply on ${discussionLabel}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  const replaceOnDiscussion = async (
    handle: FastAgentReplyHandle | null,
    message: string,
  ): Promise<FastAgentReplyHandle | null> => {
    if (handle && discussionAdapter.replaceReply) {
      try {
        return await discussionAdapter.replaceReply(handle, { message });
      } catch (error) {
        console.warn(
          `[Fast Agent] Failed to replace the Session's reply on ${discussionLabel}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return handle;
      }
    }
    return postOnDiscussion(message);
  };
  // Web and automation homes keep only the transcript, so there is nothing
  // on the home surface to replace; the discussion still needs the update.
  const homeHoldsNoMessages =
    turn.conversation.surface === 'web' ||
    turn.conversation.surface === 'automation';

  return {
    ...turn,
    adapter: {
      ...turn.adapter,
      launchTask: discussionAdapter.launchTask,
      postReply: async (reply) => {
        const homeReply =
          attributionPending && !homeHoldsNoMessages
            ? { ...reply, message: `${attribution}\n\n${reply.message}` }
            : reply;
        attributionPending = false;
        const [homeHandle, discussionHandle] = await Promise.all([
          turn.adapter.postReply(homeReply),
          postOnDiscussion(reply.message),
        ]);
        return encodeRoutedReplyHandle({
          home: homeHandle ?? null,
          discussion: discussionHandle,
        });
      },
      // Replacement is offered whenever either side can honor it. A home that
      // holds messages but cannot edit them (Linear) still receives the
      // replacement as a fresh reply, the same outcome it has without a
      // routed target, while the discussion comment is edited in place.
      ...(turn.adapter.replaceReply ||
      discussionAdapter.replaceReply ||
      homeHoldsNoMessages
        ? {
            replaceReply: async (handle, reply) => {
              const parts = decodeRoutedReplyHandle(handle);
              const [homeHandle, discussionHandle] = await Promise.all([
                parts.home && turn.adapter.replaceReply
                  ? turn.adapter.replaceReply(parts.home, reply)
                  : homeHoldsNoMessages
                    ? Promise.resolve(undefined)
                    : turn.adapter.postReply(reply),
                replaceOnDiscussion(parts.discussion, reply.message),
              ]);
              return encodeRoutedReplyHandle({
                home: homeHandle ?? parts.home,
                discussion: discussionHandle,
              });
            },
          }
        : {}),
    },
  };
}

/**
 * Separates the home and discussion message ids inside one reply handle. The
 * service persists only `messageId` for a retry notice and hands that string
 * back on a resumed turn, so both sides have to travel in it for the
 * replacement to reach the pull request after a process change. The marker
 * cannot occur in a Slack ts, a Discord snowflake, or a provider comment id.
 */
const ROUTED_REPLY_HANDLE_MARKER = '|scm:';

function encodeRoutedReplyHandle({
  home,
  discussion,
}: {
  home: FastAgentReplyHandle | null;
  discussion: FastAgentReplyHandle | null;
}): FastAgentReplyHandle | undefined {
  if (home && discussion) {
    return {
      messageId: `${home.messageId}${ROUTED_REPLY_HANDLE_MARKER}${discussion.messageId}`,
    };
  }
  if (discussion) {
    return {
      messageId: `${ROUTED_REPLY_HANDLE_MARKER}${discussion.messageId}`,
    };
  }
  return home ?? undefined;
}

function decodeRoutedReplyHandle(handle: FastAgentReplyHandle): {
  home: FastAgentReplyHandle | null;
  discussion: FastAgentReplyHandle | null;
} {
  const markerIndex = handle.messageId.indexOf(ROUTED_REPLY_HANDLE_MARKER);
  if (markerIndex < 0) {
    return { home: handle, discussion: null };
  }
  const homeMessageId = handle.messageId.slice(0, markerIndex);
  const discussionMessageId = handle.messageId.slice(
    markerIndex + ROUTED_REPLY_HANDLE_MARKER.length,
  );
  return {
    home: homeMessageId ? { messageId: homeMessageId } : null,
    discussion: discussionMessageId ? { messageId: discussionMessageId } : null,
  };
}

async function createFastAgentParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  actorUserId?: string;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  const turn = await createFastAgentHomeParentTurn(params);
  return params.event.type === 'human_follow_up'
    ? withSourceControlReplyTarget(turn, { ...params, event: params.event })
    : turn;
}

async function createFastAgentHomeParentTurn(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  actorUserId?: string;
  onReplyPosted: () => void;
}): Promise<FastAgentParentTurn> {
  if (params.parent.conversation.surface === 'automation') {
    return createAutomationFastAgentParentTurn(params);
  }
  if (params.parent.conversation.surface === 'web') {
    return createWebFastAgentParentTurn(params);
  }
  if (params.parent.conversation.surface === 'linear') {
    return createLinearFastAgentParentTurn(params);
  }
  if (isFastAgentSourceControlConversation(params.parent.conversation)) {
    return createSourceControlFastAgentParentTurn(params);
  }

  const pullRequest =
    params.event.type === 'pull_request_opened' ||
    params.event.type === 'pull_request_feedback' ||
    params.event.type === 'pull_request_conflict_detected'
      ? params.event.pullRequest
      : null;
  const pullRequests =
    params.event.type === 'task_settled' ? params.event.pullRequests : [];
  const footerContext = await resolveFastSessionReplyFooterContext({
    sessionId: params.parent.sessionId,
    pullRequest,
    pullRequests,
  });
  const turnParams = { ...params, footerContext };

  switch (params.parent.conversation.surface) {
    case 'slack':
      return createSlackFastAgentParentTurn(turnParams);
    case 'discord':
      return createDiscordFastAgentParentTurn(turnParams);
    case 'teams':
      return createTeamsFastAgentParentTurn(turnParams);
    case 'telegram':
      return createTelegramFastAgentParentTurn(turnParams);
  }
}

type FastAgentParentEventDeliveryParams = {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  retryTaskStart?: () => Promise<
    { success: true; runId: number } | { success: false; error: string }
  >;
  /** Cap the turn-lock wait so callers holding an HTTP request can fail fast
   * and lean on their own retry instead of blocking. */
  lockWaitMs?: number;
  /** The queue is re-running an inline-admitted human turn that was
   * interrupted before it finished. */
  resumedAfterInterruption?: boolean;
  /** The queue is re-running an inline-admitted human turn whose previous
   * execution parked it for a durable inference retry. */
  resumedAfterInferenceRetry?: boolean;
  /** The inline-admitted row the resumed run executes and settles, with the
   * automatic retries earlier executions already consumed. */
  durableAdmission?: { eventId: string; inferenceRetries?: number };
  /** Queue wakeups a resumed run uses when it hands the row back again:
   * immediately after an interruption, or at a scheduled retry time. */
  requestDurableResume?: () => Promise<void>;
  requestDurableRetry?: (retryAt: Date) => Promise<void>;
};

/** Give a structured child event to the Fast orchestrator for presentation. */
function buildFastAutomationFailureReport(
  event: Extract<FastAgentParentEvent, { type: 'task_settled' }>,
  surface: FastAgentConversation['surface'],
): string {
  const subject = event.title ? `"${event.title}"` : 'The delegated task';
  const detail = event.error ? `: ${event.error}` : '.';
  // The Slack card carries the task link itself.
  return surface === 'slack'
    ? `${subject} failed${detail}`
    : `${subject} failed${detail}\n${event.taskUrl}`;
}

export async function deliverFastAgentParentEvent(
  params: FastAgentParentEventDeliveryParams,
): Promise<'delivered' | 'skipped'> {
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

  try {
    return await deliverFastAgentParentEventWithLock(params, releaseTurnLock);
  } finally {
    await releaseTurnLock();
  }
}

/**
 * Process one already-admitted event while a queue drainer owns the parent
 * conversation. The caller owns lock release and may invoke this repeatedly
 * to preserve durable queue order without letting another turn interleave.
 */
export async function deliverFastAgentParentEventWithLock(
  params: FastAgentParentEventDeliveryParams,
  turnLock: FastAgentTurnLockHandle,
): Promise<'delivered' | 'skipped'> {
  let replyPosted = false;
  const turnSignal = turnLock.signal;

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

    const humanFollowUp =
      params.event.type === 'human_follow_up' ? params.event : null;
    const parentTurn = await createFastAgentParentTurn({
      parent: params.parent,
      event: params.event,
      ...(humanFollowUp ? { actorUserId: humanFollowUp.userId } : {}),
      onReplyPosted: () => {
        replyPosted = true;
      },
    });
    // A failed automation run always reaches its destination. The model
    // judges what a result is worth, but a broken automation must not stay
    // silent, so this closeout is fixed text rather than a model turn.
    if (
      params.event.type === 'task_settled' &&
      params.event.customAutomationId &&
      params.event.status === 'failed' &&
      parentTurn.conversation.surface !== 'automation'
    ) {
      await parentTurn.adapter.postReply({
        purpose: 'closeout',
        message: buildFastAutomationFailureReport(
          params.event,
          parentTurn.conversation.surface,
        ),
      });
      return 'delivered';
    }
    // The same base URL must reach both the config resolver and the broker:
    // the broker only injects its auth header on deployment-proxy URLs whose
    // origin matches its own apiBaseUrl, so a mismatched pair silently drops
    // every deployment MCP server from parent-event turns.
    const apiBaseUrl = resolveApiBaseUrl() ?? undefined;
    await answerFastAgentQuestion({
      question:
        humanFollowUp?.question ??
        `<platform_event>${JSON.stringify(params.event)}</platform_event>`,
      ...(humanFollowUp?.images ? { images: humanFollowUp.images } : {}),
      userId: humanFollowUp?.userId ?? parentTurn.userId,
      conversation: parentTurn.conversation,
      currentMessageId:
        humanFollowUp?.currentMessageId ??
        buildEventClientMessageSeed(params.event),
      apiBaseUrl,
      signal: turnSignal,
      ...(humanFollowUp?.senderDisplayName
        ? { senderDisplayName: humanFollowUp.senderDisplayName }
        : {}),
      ...(humanFollowUp?.senderExternalId
        ? { senderExternalId: humanFollowUp.senderExternalId }
        : {}),
      ...(humanFollowUp?.agentContext
        ? { currentMessageAgentContext: humanFollowUp.agentContext }
        : {}),
      ...(humanFollowUp?.activeTasks?.length
        ? {
            activeTasks: humanFollowUp.activeTasks.map((task) => ({
              taskId: task.taskId,
              ...(task.title ? { title: task.title } : {}),
              ...(task.status ? { status: task.status as RunStatus } : {}),
            })),
          }
        : {}),
      // A durable human row can carry a reaction or a platform event that
      // was admitted through the human path; a resumed run keeps that
      // framing rather than reading the event text as a typed message.
      turnSource:
        humanFollowUp?.turnSource ??
        (humanFollowUp ? 'human' : 'platform_event'),
      ...(humanFollowUp?.input ? { input: humanFollowUp.input } : {}),
      ...(humanFollowUp?.setupSession ? { setupSession: true } : {}),
      ...(humanFollowUp
        ? { currentDurableHumanFollowUpEventId: humanFollowUp.eventId }
        : {}),
      ...(params.resumedAfterInterruption
        ? { resumedAfterInterruption: true }
        : {}),
      ...(params.resumedAfterInferenceRetry
        ? { resumedAfterInferenceRetry: true }
        : {}),
      ...(params.durableAdmission
        ? { durableAdmission: params.durableAdmission }
        : {}),
      platformEventHandling:
        params.event.type === 'pull_request_feedback' ||
        params.event.type === 'pull_request_conflict_detected'
          ? 'present_only'
          : 'default',
      platformEventVisibility:
        humanFollowUp?.platformEventVisibility ??
        (params.event.type === 'pull_request_feedback' ||
        params.event.type === 'pull_request_conflict_detected' ||
        params.event.type === 'automation_triggered'
          ? 'required'
          : 'optional'),
      platformEventKind:
        humanFollowUp?.platformEventKind ??
        (params.event.type === 'automation_triggered'
          ? 'automation'
          : 'delegated_task'),
      automationReport:
        params.event.type === 'task_settled' &&
        Boolean(params.event.customAutomationId),
      ...(params.event.type === 'child_message' &&
      params.event.imageArtifactIds?.length
        ? { defaultImageArtifactIds: params.event.imageArtifactIds }
        : {}),
      ...(params.event.type === 'pull_request_feedback' ||
      params.event.type === 'pull_request_status_changed'
        ? {
            platformEventTranscriptPayload: {
              prReview: {
                ...(params.event.type === 'pull_request_feedback' &&
                params.event.reviewTaskId
                  ? { reviewTaskId: params.event.reviewTaskId }
                  : {}),
                url: params.event.pullRequest.url,
                repository: params.event.pullRequest.repository,
                number: params.event.pullRequest.number,
                summary:
                  params.event.type === 'pull_request_feedback'
                    ? params.event.summary
                    : '',
                findingCount:
                  params.event.type === 'pull_request_feedback'
                    ? (params.event.reviewResult?.findingCount ?? null)
                    : null,
                status:
                  params.event.type === 'pull_request_status_changed'
                    ? params.event.status
                    : params.event.reviewResult?.approvalStatus === 'approved'
                      ? 'approved'
                      : 'feedback',
              },
              ...(params.event.type === 'pull_request_feedback' &&
              params.event.reviewActionDeliveryId &&
              params.event.suggestedActionQuestion
                ? {
                    prReviewAction: {
                      deliveryId: params.event.reviewActionDeliveryId,
                      question: params.event.suggestedActionQuestion,
                      status: 'pending',
                    },
                  }
                : {}),
            },
          }
        : {}),
      adapter: {
        createArtifact: buildFastAgentArtifactCreator(params.parent.sessionId),
        ...parentTurn.adapter,
        launchTask: parentTurn.adapter.launchTask,
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId: parentTurn.userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        ...(params.retryTaskStart
          ? { retryTaskStart: params.retryTaskStart }
          : {}),
        ...(params.requestDurableResume
          ? { requestDurableResume: params.requestDurableResume }
          : {}),
        ...(params.requestDurableRetry
          ? { requestDurableRetry: params.requestDurableRetry }
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
  }
}
