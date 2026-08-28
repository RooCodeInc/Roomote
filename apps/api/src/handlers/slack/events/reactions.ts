import { acquireRedisLock } from '@roomote/redis';
import {
  AGENT_DISPLAY_NAME,
  formatErrorForLog,
  normalizeSetupNewState,
} from '@roomote/types';
import {
  buildSeededSuggestionSlackText,
  buildSuggestionBadgePrefix,
  buildSuggestionSlackText,
  buildSuggestionTaskPromptText,
  findMatchingEnvironmentIdForRepositoryIds,
  parseSetupSuggestionIdFromSlackMessageMetadata,
  repositoryIdsMatchSelection,
  resolveSuggestionLaunchWorkspaceFromMetadata,
  type SuggestionLaunchWorkspace,
} from '../helpers/suggestion-workspace.js';
import {
  resolveSlackReactionNames,
  startAutoRoutedSlackTask,
  startSlackAppMentionTask,
  type SlackNotifier,
  type SlackReactionAddedEvent,
} from '@roomote/slack';
import {
  and,
  claimWorkItem,
  db,
  eq,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  trackedMessages,
  workItems,
} from '@roomote/db/server';

import { apiLogger } from '../../../logging.js';
import { getCallRoomoteViaEmojiConfiguration } from '../../call-roomote-via-emoji.js';
import { launchClaimedSuggestedTask } from '../../tasks/suggestion-launch.js';
import {
  SLACK_SETUP_SUGGESTION_LOCK_PREFIX,
  TASK_SUGGESTION_TYPES,
} from '../constants.js';
import type { SlackWebhookContext } from '../context.js';
import { isThumbsUpReaction } from '../helpers/event-normalization.js';
import { postTaskSuggestionStartedMessage } from '../helpers/thread-posting.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';
import {
  runTaskSuggestionReactionContention,
  type TaskSuggestionReactionLaunchResult,
  type TaskSuggestionReactionState,
} from './task-suggestion-reaction-contention.js';
import {
  handleMessageOrAppMentionEvent,
  startFastAgentResponse,
} from './message-entry.js';

export async function maybeCallRoomoteViaEmoji(params: {
  context: SlackWebhookContext;
  event: SlackReactionAddedEvent;
}): Promise<boolean> {
  const configuration = await getCallRoomoteViaEmojiConfiguration(
    params.event.reaction,
  );
  if (!configuration) {
    return false;
  }

  const targetMessage = await params.context.slack.getMessage({
    channel: params.event.item.channel,
    messageTs: params.event.item.ts,
  });
  if (!targetMessage) {
    apiLogger.warn(
      `[SlackWebhook] Could not resolve emoji summon target ${params.event.item.channel}:${params.event.item.ts}`,
    );
    return true;
  }

  await handleMessageOrAppMentionEvent({
    context: params.context,
    event: {
      type: 'app_mention',
      channel: params.event.item.channel,
      user: params.event.user,
      text: `<@${params.context.slackInstallation.botUserId}> ${configuration.prompt}\n\nMessage to act on:\n${targetMessage.text}`,
      ts: params.event.item.ts,
      deliveryTs: params.event.event_ts,
      thread_ts: targetMessage.thread_ts ?? targetMessage.ts,
      files: targetMessage.files,
    },
  });

  return true;
}

async function postSuggestionLaunchFailureMessage(params: {
  slack: SlackNotifier;
  channelId: string;
  title: string;
  brief: string;
  reason: string;
}): Promise<void> {
  const text = `**${params.title}**\n${params.brief}\n\n${params.reason}`;

  await params.slack.postMessage({
    channel: params.channelId,
    text,
    blocks: [
      {
        type: 'markdown',
        text,
      },
    ],
  });
}

const TASK_SUGGESTION_REACTION_LOCK_TTL_SECONDS = 30;
const TASK_SUGGESTION_REACTION_POLL_INTERVAL_MS = 400;
const TASK_SUGGESTION_REACTION_MAX_ATTEMPTS = Math.ceil(
  (TASK_SUGGESTION_REACTION_LOCK_TTL_SECONDS * 1000) /
    TASK_SUGGESTION_REACTION_POLL_INTERVAL_MS,
);

/**
 * Reaction-launchable suggestion types tracked on the suggestion_card's
 * `metadata.suggestionType`.
 */
function getLaunchableSuggestionType(
  metadata: Record<string, unknown> | null | undefined,
): (typeof TASK_SUGGESTION_TYPES)[number] | null {
  const suggestionType = metadata?.suggestionType;

  if (
    typeof suggestionType === 'string' &&
    (TASK_SUGGESTION_TYPES as readonly string[]).includes(suggestionType)
  ) {
    return suggestionType as (typeof TASK_SUGGESTION_TYPES)[number];
  }

  return null;
}

/**
 * Finalize a successful launch via the shared work_items helper (`launching` →
 * `launched` with the task link, guarded so a race is idempotent) and, when it
 * wins, record the seeded thread on the tracked suggestion card. Returns false
 * when another launcher already finalized the work item.
 */
async function markWorkItemLaunched(params: {
  workItemId: string;
  trackedMessageId: string;
  taskId: string | null;
  /** The claiming launcher's fencing token (claimed row's `launchClaimedAt`). */
  claimedAt: Date;
  launchedThreadTs?: string;
}): Promise<boolean> {
  const finalized = await finalizeWorkItemLaunched(db, {
    id: params.workItemId,
    taskId: params.taskId,
    claimedAt: params.claimedAt,
  });

  if (!finalized) {
    return false;
  }

  if (params.launchedThreadTs) {
    await db
      .update(trackedMessages)
      .set({ threadTs: params.launchedThreadTs, updatedAt: new Date() })
      .where(eq(trackedMessages.id, params.trackedMessageId));
  }

  return true;
}

const REMOVED_SLACK_ACCOUNT_LAUNCH_FAILURE =
  'I could not start this because your linked Roomote account was removed. Ask an admin to restore your access, then reconnect Slack.';

async function launchTaskSuggestionTaskFromReaction({
  teamId,
  slackInstallation,
  slack,
  reactionEvent,
  ackEmoji,
  completionEmoji,
}: {
  teamId: string;
  slackInstallation: SlackWebhookContext['slackInstallation'];
  slack: SlackNotifier;
  reactionEvent: SlackReactionAddedEvent;
  ackEmoji: string;
  completionEmoji: string;
}): Promise<TaskSuggestionReactionLaunchResult> {
  if (reactionEvent.item.type !== 'message') {
    return false;
  }

  const channelId = reactionEvent.item.channel;
  const messageTs = reactionEvent.item.ts;
  const logPrefix = `[SetupSuggestionLifecycle] team=${teamId} channel=${channelId} sourceMessageTs=${messageTs} reaction=${reactionEvent.reaction} user=${reactionEvent.user}`;

  apiLogger.debug(
    `${logPrefix} begin launchSetupOnboardingSuggestionTaskFromReaction`,
  );

  // Resolve the tracked suggestion card for the reacted message. The card's
  // metadata carries the suggestion type; its workItemId points at the backing
  // work_items row that owns the launch state machine.
  const cardColumns = {
    id: true as const,
    workItemId: true as const,
    metadata: true as const,
  };

  const directCard = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.kind, 'suggestion_card'),
      eq(trackedMessages.channelId, channelId),
      eq(trackedMessages.messageTs, messageTs),
    ),
    columns: cardColumns,
  });

  let suggestionCard =
    directCard && getLaunchableSuggestionType(directCard.metadata)
      ? directCard
      : null;

  const suggestionIdFromMetadata = !suggestionCard
    ? parseSetupSuggestionIdFromSlackMessageMetadata(
        await slack.getMessageMetadata({
          channel: channelId,
          messageTs,
        }),
      )
    : null;

  if (suggestionIdFromMetadata) {
    apiLogger.debug(
      `${logPrefix} metadata fallback resolved suggestionId=${suggestionIdFromMetadata}`,
    );
  }

  if (!suggestionCard && suggestionIdFromMetadata) {
    // The metadata suggestionId is the backing work item id.
    const fallbackCard = await db.query.trackedMessages.findFirst({
      where: and(
        eq(trackedMessages.kind, 'suggestion_card'),
        eq(trackedMessages.workItemId, suggestionIdFromMetadata),
      ),
      columns: cardColumns,
    });

    suggestionCard =
      fallbackCard && getLaunchableSuggestionType(fallbackCard.metadata)
        ? fallbackCard
        : null;
  }

  const suggestionType = suggestionCard
    ? getLaunchableSuggestionType(suggestionCard.metadata)
    : null;

  if (!suggestionCard || !suggestionCard.workItemId || !suggestionType) {
    apiLogger.debug(
      `${logPrefix} no tracked setup suggestion found for reaction (direct lookup + metadata fallback)`,
    );
    return false;
  }

  const workItemId = suggestionCard.workItemId;

  const [workItem] = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      brief: workItems.brief,
      category: workItems.category,
      priority: workItems.priority,
      investigationContext: workItems.investigationContext,
      repositoryIds: workItems.repositoryIds,
      targetRepositoryFullName: workItems.targetRepositoryFullName,
      targetEnvironmentId: workItems.targetEnvironmentId,
      readinessMessage: workItems.readinessMessage,
      sortOrder: workItems.sortOrder,
      status: workItems.status,
    })
    .from(workItems)
    .where(eq(workItems.id, workItemId))
    .limit(1);

  if (!workItem) {
    return false;
  }

  // `open` is launchable, and `launching` is allowed through so the shared
  // claim CAS below can reclaim a *stale* launching item (a launcher that
  // crashed before finalizing) while still rejecting a fresh one. launched /
  // failed / dismissed are terminal for this surface.
  if (workItem.status !== 'open' && workItem.status !== 'launching') {
    apiLogger.debug(
      `${logPrefix} suggestion already handled (status=${workItem.status}), skipping duplicate launch`,
    );
    return false;
  }

  const suggestionBrief = workItem.brief ?? '';
  // Cards marked launchRouting: 'router' are presentation-only chat-reply
  // suggestions; the task router selects the workspace at launch. Unmarked
  // cards (scan, setup, and cards posted before the marker existed) launch
  // pinned to their persisted targets.
  const usesRouterLaunch =
    suggestionType === 'suggested_tasks' &&
    suggestionCard.metadata?.launchRouting === 'router';

  let suggestionWorkspace: SuggestionLaunchWorkspace | null = null;
  let launchFailureReason: string | null = null;

  if (suggestionType === 'setup_onboarding') {
    const deploymentSettings = await db.query.deploymentSettings.findFirst({
      columns: { setupNewState: true },
    });
    const setupNewState = normalizeSetupNewState(
      deploymentSettings?.setupNewState,
    );

    if (
      !setupNewState.onboardingTaskId ||
      setupNewState.onboardingTaskStartedAt === null
    ) {
      return false;
    }

    if (
      !repositoryIdsMatchSelection(
        workItem.repositoryIds,
        setupNewState.selectedRepositoryIds,
      )
    ) {
      apiLogger.debug(
        `${logPrefix} repository selection mismatch for workItemId=${workItemId}`,
      );
      return false;
    }

    const matchingEnvironment = await findMatchingEnvironmentIdForRepositoryIds(
      {
        repositoryIds: setupNewState.selectedRepositoryIds,
        minimumCreatedAt: setupNewState.onboardingTaskStartedAt,
      },
    );
    const suggestionTargetRepositoryFullName =
      workItem.targetRepositoryFullName?.trim() || null;

    if (!matchingEnvironment) {
      launchFailureReason =
        "I couldn't start this setup suggestion because the matching environment is no longer available.";
    } else if (suggestionTargetRepositoryFullName) {
      const includesTargetRepository =
        matchingEnvironment.configuredRepositoryFullNames.some(
          (repositoryFullName) =>
            repositoryFullName.toLowerCase() ===
            suggestionTargetRepositoryFullName.toLowerCase(),
        );

      if (!includesTargetRepository) {
        launchFailureReason = `I couldn't start this setup suggestion because the onboarding environment no longer includes \`${suggestionTargetRepositoryFullName}\`.`;
      } else {
        suggestionWorkspace = {
          repoForPayload: suggestionTargetRepositoryFullName,
          environmentId: matchingEnvironment.id,
          workspaceDisplayName: matchingEnvironment.name,
        };
      }
    } else if (workItem.repositoryIds.length > 1) {
      launchFailureReason =
        "I couldn't start this setup suggestion because it was generated before per-idea launch targeting was saved. Regenerate the setup suggestions and react again.";
    } else {
      suggestionWorkspace = {
        repoForPayload: matchingEnvironment.repoForPayload,
        environmentId: matchingEnvironment.id,
        workspaceDisplayName: matchingEnvironment.name,
      };
    }
  } else if (suggestionType === 'suggested_tasks' && !usesRouterLaunch) {
    const resolved = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: workItem.targetRepositoryFullName,
      targetEnvironmentId: workItem.targetEnvironmentId,
      readinessMessage: workItem.readinessMessage,
    });
    suggestionWorkspace = resolved.workspace;
    launchFailureReason = resolved.failureReason;
  } else if (suggestionType !== 'suggested_tasks') {
    return false;
  }

  const reactingUserMapping: Awaited<
    ReturnType<typeof lookupSlackUserMapping>
  > = await lookupSlackUserMapping({
    slackUserId: reactionEvent.user,
    teamId,
  });

  if (reactingUserMapping.hasInactiveMapping) {
    await postSuggestionLaunchFailureMessage({
      slack,
      channelId,
      title: `${buildSuggestionBadgePrefix({
        category: workItem.category,
        priority: workItem.priority,
      })}${workItem.title}`,
      brief: suggestionBrief,
      reason: REMOVED_SLACK_ACCOUNT_LAUNCH_FAILURE,
    });
    return true;
  }

  const claimedWorkItem = await claimWorkItem(db, { id: workItemId });

  if (!claimedWorkItem) {
    return true;
  }

  // The claim's `launch_claimed_at` is this launcher's fencing token; thread it
  // through every finalize/release so a slow launcher whose stale claim was
  // reclaimed cannot stomp the new claimant's state.
  const claimedAt = claimedWorkItem.launchClaimedAt;

  if (!usesRouterLaunch && !suggestionWorkspace) {
    await releaseWorkItemClaim(db, { id: workItemId, claimedAt });

    apiLogger.warn(
      `${logPrefix} suggestion launch failed before task start: ${launchFailureReason ?? 'missing launch workspace'}`,
    );

    if (launchFailureReason) {
      await postSuggestionLaunchFailureMessage({
        slack,
        channelId,
        title: `${buildSuggestionBadgePrefix({
          category: workItem.category,
          priority: workItem.priority,
        })}${workItem.title}`,
        brief: suggestionBrief,
        reason: launchFailureReason,
      }).catch((error) => {
        console.warn(
          `${logPrefix} failed to post visible launch failure message: ${formatErrorForLog(error)}`,
        );
      });
    }

    return true;
  }

  const suggestionSlackText = buildSuggestionSlackText({
    title: workItem.title,
    brief: suggestionBrief,
  });
  const seededSuggestionSlackText = buildSeededSuggestionSlackText(
    suggestionSlackText,
    reactionEvent.user,
  );
  const suggestionTaskPrompt = buildSuggestionTaskPromptText({
    title: workItem.title,
    brief: suggestionBrief,
    investigationContext: workItem.investigationContext,
    readinessMessage: !usesRouterLaunch
      ? (suggestionWorkspace?.readinessMessage ?? workItem.readinessMessage)
      : null,
    suggestionType,
    category: workItem.category,
    priority: workItem.priority,
    targetRepositoryFullName: !usesRouterLaunch
      ? workItem.targetRepositoryFullName
      : null,
  });

  let seededThreadTs: string | undefined;
  let taskRun: { id: number | null; taskId: string | null } | null = null;
  const directWorkspaceName = suggestionWorkspace?.workspaceDisplayName ?? null;
  try {
    seededThreadTs = await slack.postMessage({
      channel: channelId,
      text: seededSuggestionSlackText,
      blocks: [
        {
          type: 'markdown',
          text: seededSuggestionSlackText,
        },
      ],
    });

    if (!seededThreadTs) {
      await releaseWorkItemClaim(db, { id: workItemId, claimedAt });
      apiLogger.debug(
        `${logPrefix} failed to seed top-level Slack message; launch canceled`,
      );
      return false;
    }
    const launchThreadTs = seededThreadTs;

    const initiator = {
      kind: 'user' as const,
      externalId: reactionEvent.user,
      ...(reactingUserMapping.activeMapping?.userId
        ? { matchedUserId: reactingUserMapping.activeMapping.userId }
        : {}),
    };

    const activeUserMapping = reactingUserMapping.activeMapping;
    const launchResult = await launchClaimedSuggestedTask({
      suggestion: { id: workItemId, launchClaimedAt: claimedAt },
      policy: {
        usesRouterLaunch,
        userDefaultEnabled:
          activeUserMapping?.communicationsFastModeDefault === true,
        fastAvailable: Boolean(activeUserMapping),
      },
      launch: async (launchMode) => {
        if (launchMode === 'fast') {
          if (!activeUserMapping) {
            return { accepted: false, reason: 'Fast mode is unavailable.' };
          }
          const fastStart = await startFastAgentResponse({
            event: {
              type: 'app_mention',
              channel: channelId,
              user: reactionEvent.user,
              text: `Start this suggested task: ${workItem.title}\n\n${suggestionBrief}`,
              agentContext: suggestionTaskPrompt,
              ts: launchThreadTs,
              thread_ts: launchThreadTs,
            },
            slackInstallation,
            userMapping: activeUserMapping,
            slack,
            userId: activeUserMapping.userId,
            teamId,
            continuation: true,
            processingReactionName: ackEmoji,
            errorLogPrefix: `Failed to start Fast suggestion response for work item ${workItemId}:`,
          });
          return fastStart.accepted
            ? { accepted: true, runId: null, taskId: null }
            : fastStart;
        }

        if (usesRouterLaunch) {
          const routedLaunch = await startAutoRoutedSlackTask({
            slackInstallation,
            slack,
            initiator,
            trigger: 'manual',
            launchUserId: activeUserMapping?.userId,
            slackUserId: reactionEvent.user,
            persistedSlackUserId: reactionEvent.user,
            initiatingSlackUserId: reactionEvent.user,
            channel: channelId,
            prompt: `Start this suggested task: ${workItem.title}\n\n${suggestionBrief}`,
            threadTs: launchThreadTs,
            originMessageTs: launchThreadTs,
            agentPromptTextOverride: suggestionTaskPrompt,
            skipMcpSetupSuggestion: true,
          });
          return routedLaunch.status === 'started'
            ? {
                accepted: true,
                runId: routedLaunch.runId,
                taskId: routedLaunch.taskId,
              }
            : {
                accepted: false,
                reason:
                  routedLaunch.message ||
                  "I couldn't determine which workspace should run this suggestion.",
              };
        }

        if (!suggestionWorkspace) {
          throw new Error('Setup suggestion workspace was not resolved.');
        }
        const directLaunch = await startSlackAppMentionTask({
          initiator,
          trigger: 'manual',
          channel: channelId,
          teamId,
          slackUserId: reactionEvent.user,
          text: suggestionSlackText,
          agentPromptText: suggestionTaskPrompt,
          ts: launchThreadTs,
          threadTs: launchThreadTs,
          repo: suggestionWorkspace.repoForPayload,
          environmentId: suggestionWorkspace.environmentId,
          readinessMessage: suggestionWorkspace.readinessMessage ?? undefined,
          webPath: suggestionType === 'setup_onboarding' ? '/setup' : undefined,
          ackEmoji,
          completionEmoji,
          queuedStartedMessage: {
            ts: launchThreadTs,
            agentName: AGENT_DISPLAY_NAME,
            initiatingSlackUserId: reactionEvent.user,
            workspaceDisplayName: suggestionWorkspace.workspaceDisplayName,
            workspaceOnly: false,
          },
        });
        return {
          accepted: true,
          runId: directLaunch.id,
          taskId: directLaunch.taskId,
        };
      },
      finalize: (taskId) =>
        markWorkItemLaunched({
          workItemId,
          trackedMessageId: suggestionCard.id,
          taskId,
          claimedAt,
          launchedThreadTs: seededThreadTs,
        }),
    });

    if (
      launchResult.status === 'rejected' ||
      launchResult.status === 'failed'
    ) {
      await slack
        .deleteMessage({ channel: channelId, ts: seededThreadTs })
        .catch(() => {});
      await postSuggestionLaunchFailureMessage({
        slack,
        channelId,
        title: workItem.title,
        brief: suggestionBrief,
        reason:
          launchResult.status === 'rejected'
            ? (launchResult.reason ?? 'The suggestion could not be started.')
            : formatErrorForLog(launchResult.error),
      });
      return true;
    }

    if (
      launchResult.status === 'finalize_lost' ||
      launchResult.status === 'finalize_failed'
    ) {
      apiLogger.warn(
        `${logPrefix} failed to finalize work item ${workItemId}; task ${launchResult.taskId ?? 'null'} (run ${launchResult.runId ?? 'null'}) — ${launchResult.cancelNote}`,
      );
      await slack
        .deleteMessage({ channel: channelId, ts: seededThreadTs })
        .catch(() => {});
      return true;
    }

    taskRun = { id: launchResult.runId, taskId: launchResult.taskId };

    if (!usesRouterLaunch && directWorkspaceName) {
      await postTaskSuggestionStartedMessage({
        slack,
        channelId,
        threadTs: seededThreadTs,
        workspaceName: directWorkspaceName,
        runId: taskRun.id,
        initiatingSlackUserId: reactionEvent.user,
        taskId: taskRun.taskId,
      }).catch((error) => {
        apiLogger.warn(
          `${logPrefix} failed to post started message: ${formatErrorForLog(error)}`,
        );
      });
    }

    apiLogger.debug(
      `${logPrefix} completed reaction launch lifecycle taskId=${taskRun.taskId ?? 'null'} launchedThreadTs=${seededThreadTs}`,
    );
    return true;
  } catch (error) {
    if (seededThreadTs) {
      await slack
        .deleteMessage({ channel: channelId, ts: seededThreadTs })
        .catch(() => {});
    }
    await releaseWorkItemClaim(db, { id: workItemId, claimedAt }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function getTaskSuggestionReactionState(input: {
  channelId: string;
  messageTs: string;
}): Promise<TaskSuggestionReactionState | null> {
  const suggestionCard = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.kind, 'suggestion_card'),
      eq(trackedMessages.channelId, input.channelId),
      eq(trackedMessages.messageTs, input.messageTs),
    ),
    columns: { workItemId: true, threadTs: true, metadata: true },
  });

  if (
    !suggestionCard ||
    !suggestionCard.workItemId ||
    !getLaunchableSuggestionType(suggestionCard.metadata)
  ) {
    return null;
  }

  const [workItem] = await db
    .select({
      status: workItems.status,
      launchedTaskId: workItems.launchedTaskId,
      launchClaimedAt: workItems.launchClaimedAt,
    })
    .from(workItems)
    .where(eq(workItems.id, suggestionCard.workItemId))
    .limit(1);

  if (!workItem) {
    return null;
  }

  // Map the work_items launch state onto the reaction-contention shape: a
  // launched item exposes its task + seeded thread; a claim in flight exposes
  // launchClaimedAt so contenders wait.
  return {
    taskId: workItem.launchedTaskId,
    launchClaimedAt: workItem.launchClaimedAt,
    launchedThreadTs:
      workItem.status === 'launched' ? suggestionCard.threadTs : null,
  };
}

async function launchTaskSuggestionTaskWithContention(params: {
  lockKey: string;
  channelId: string;
  messageTs: string;
  launch: () => Promise<TaskSuggestionReactionLaunchResult>;
}): Promise<boolean> {
  const lifecycleResult = await runTaskSuggestionReactionContention({
    acquireLock: () =>
      acquireRedisLock(params.lockKey, {
        ttlSeconds: TASK_SUGGESTION_REACTION_LOCK_TTL_SECONDS,
      }),
    launch: params.launch,
    getState: () =>
      getTaskSuggestionReactionState({
        channelId: params.channelId,
        messageTs: params.messageTs,
      }),
    maxAttempts: TASK_SUGGESTION_REACTION_MAX_ATTEMPTS,
    pollIntervalMs: TASK_SUGGESTION_REACTION_POLL_INTERVAL_MS,
    onStateTransition: async (state) => {
      if (state === 'lock-lost') {
        apiLogger.warn(
          `[SetupSuggestionLifecycle] channel=${params.channelId} sourceMessageTs=${params.messageTs} lost the setup suggestion lock while waiting for an earlier claim to clear`,
        );
      }
    },
  });

  return lifecycleResult === 'handled';
}

export async function handleReactionAddedEvent(params: {
  context: SlackWebhookContext;
  event: SlackReactionAddedEvent;
}): Promise<void> {
  const { context, event } = params;

  const isMessageItem = event.item.type === 'message';
  if (!isMessageItem) {
    return;
  }

  if (event.user === context.slackInstallation.botUserId) {
    apiLogger.debug(
      `[SlackWebhook] Ignoring self-reaction from bot user ${event.user} on ${event.item.channel}:${event.item.ts}`,
    );
    return;
  }

  if (await maybeCallRoomoteViaEmoji({ context, event })) {
    return;
  }

  const reactionNames = await resolveSlackReactionNames();

  if (isThumbsUpReaction(event.reaction)) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Processing thumbs-up reaction team=${context.teamId} channel=${event.item.channel} messageTs=${event.item.ts} reaction=${event.reaction} user=${event.user}`,
    );
    const setupSuggestionLockKey = `${SLACK_SETUP_SUGGESTION_LOCK_PREFIX}${event.item.channel}:${event.item.ts}`;
    const setupSuggestionHandled = await launchTaskSuggestionTaskWithContention(
      {
        lockKey: setupSuggestionLockKey,
        channelId: event.item.channel,
        messageTs: event.item.ts,
        launch: () =>
          launchTaskSuggestionTaskFromReaction({
            teamId: context.teamId,
            slackInstallation: context.slackInstallation,
            slack: context.slack,
            reactionEvent: event,
            ackEmoji: reactionNames.ackEmoji,
            completionEmoji: reactionNames.completionEmoji,
          }),
      },
    );

    if (setupSuggestionHandled) {
      apiLogger.debug(
        `[SlackWebhook] Setup suggestion reaction handled for ${event.item.channel}:${event.item.ts}`,
      );
      return;
    }
  }

  apiLogger.debug(
    `[SlackWebhook] Reaction no-op for ${event.item.channel}:${event.item.ts}`,
  );
}
