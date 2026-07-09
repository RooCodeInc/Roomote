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
  parseSetupSuggestionIdFromMessageKey,
  parseSetupSuggestionIdFromSlackMessageMetadata,
  repositoryIdsMatchSelection,
  resolveSuggestionLaunchWorkspaceFromMetadata,
  type SuggestionLaunchWorkspace,
} from '../helpers/suggestion-workspace.js';
import {
  resolveSlackReactionNames,
  startSlackAppMentionTask,
  type SlackNotifier,
  type SlackReactionAddedEvent,
} from '@roomote/slack';
import {
  automationWorkItems,
  agentSuggestionMessages,
  and,
  db,
  eq,
  inArray,
  isNull,
  like,
  taskSuggestions,
} from '@roomote/db/server';

import { apiLogger } from '../../../logging.js';
import {
  SLACK_SETUP_SUGGESTION_LOCK_PREFIX,
  TASK_SUGGESTION_AGENT_TYPES,
} from '../constants.js';
import type { SlackWebhookContext } from '../context.js';
import {
  isConfiguredSlackReaction,
  isThumbsUpReaction,
} from '../helpers/event-normalization.js';
import { postTaskSuggestionStartedMessage } from '../helpers/thread-posting.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';
import { handleSlackEntryEvent } from './message-entry.js';
import {
  runTaskSuggestionReactionContention,
  type TaskSuggestionReactionLaunchResult,
  type TaskSuggestionReactionState,
} from './task-suggestion-reaction-contention.js';

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

async function markTaskSuggestionStarted(params: {
  suggestionId: string;
}): Promise<void> {
  await db
    .update(taskSuggestions)
    .set({
      status: 'started',
      updatedAt: new Date(),
    })
    .where(eq(taskSuggestions.id, params.suggestionId));
}

async function markAutomationWorkItemStarted(params: {
  automationWorkItemId: string;
  taskId: string | null;
}): Promise<void> {
  await db
    .update(automationWorkItems)
    .set({
      status: 'started',
      executionTaskId: params.taskId,
      launchedAt: new Date(),
      launchError: null,
      updatedAt: new Date(),
    })
    .where(eq(automationWorkItems.id, params.automationWorkItemId));
}

async function markSuggestionLaunchStarted(params: {
  suggestionId: string;
  automationWorkItemId: string | null;
  taskId: string | null;
}): Promise<void> {
  await markTaskSuggestionStarted({
    suggestionId: params.suggestionId,
  });

  if (params.automationWorkItemId) {
    await markAutomationWorkItemStarted({
      automationWorkItemId: params.automationWorkItemId,
      taskId: params.taskId,
    });
  }
}

async function claimTaskSuggestionLaunch(
  suggestionMessageId: string,
): Promise<boolean> {
  const launchClaimedAt = new Date();
  const [claimedSuggestionMessage] = await db
    .update(agentSuggestionMessages)
    .set({
      launchClaimedAt,
    })
    .where(
      and(
        eq(agentSuggestionMessages.id, suggestionMessageId),
        isNull(agentSuggestionMessages.taskId),
        isNull(agentSuggestionMessages.launchClaimedAt),
        isNull(agentSuggestionMessages.launchedThreadTs),
      ),
    )
    .returning({ id: agentSuggestionMessages.id });

  return Boolean(claimedSuggestionMessage);
}

const REMOVED_SLACK_ACCOUNT_LAUNCH_FAILURE =
  'I could not start this because your linked Roomote account was removed. Ask an admin to restore your access, then reconnect Slack.';

async function launchTaskSuggestionTaskFromReaction({
  teamId,
  slack,
  reactionEvent,
  ackEmoji,
  completionEmoji,
}: {
  teamId: string;
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

  let [suggestionMessage] = await db
    .select({
      id: agentSuggestionMessages.id,
      agentType: agentSuggestionMessages.agentType,
      taskId: agentSuggestionMessages.taskId,
      suggestionKey: agentSuggestionMessages.suggestionKey,
      createdByUserId: agentSuggestionMessages.createdByUserId,
      launchClaimedAt: agentSuggestionMessages.launchClaimedAt,
      launchedThreadTs: agentSuggestionMessages.launchedThreadTs,
    })
    .from(agentSuggestionMessages)
    .where(
      and(
        inArray(agentSuggestionMessages.agentType, TASK_SUGGESTION_AGENT_TYPES),
        eq(agentSuggestionMessages.channelId, channelId),
        eq(agentSuggestionMessages.messageTs, messageTs),
      ),
    )
    .limit(1);

  const suggestionIdFromMetadata = !suggestionMessage
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

  if (!suggestionMessage && suggestionIdFromMetadata) {
    [suggestionMessage] = await db
      .select({
        id: agentSuggestionMessages.id,
        agentType: agentSuggestionMessages.agentType,
        taskId: agentSuggestionMessages.taskId,
        suggestionKey: agentSuggestionMessages.suggestionKey,
        createdByUserId: agentSuggestionMessages.createdByUserId,
        launchClaimedAt: agentSuggestionMessages.launchClaimedAt,
        launchedThreadTs: agentSuggestionMessages.launchedThreadTs,
      })
      .from(agentSuggestionMessages)
      .where(
        and(
          inArray(
            agentSuggestionMessages.agentType,
            TASK_SUGGESTION_AGENT_TYPES,
          ),
          like(
            agentSuggestionMessages.suggestionKey,
            `%:${suggestionIdFromMetadata}`,
          ),
        ),
      )
      .limit(1);
  }

  if (!suggestionMessage) {
    apiLogger.debug(
      `${logPrefix} no tracked setup suggestion found for reaction (direct lookup + metadata fallback)`,
    );
    return false;
  }

  if (
    suggestionMessage.taskId ||
    suggestionMessage.launchClaimedAt ||
    suggestionMessage.launchedThreadTs
  ) {
    apiLogger.debug(
      `${logPrefix} suggestion already handled, skipping duplicate launch`,
    );
    return false;
  }

  const suggestionId =
    suggestionIdFromMetadata ??
    parseSetupSuggestionIdFromMessageKey(suggestionMessage.suggestionKey);
  if (!suggestionId) {
    return false;
  }

  const [suggestion] = await db
    .select({
      id: taskSuggestions.id,
      automationWorkItemId: taskSuggestions.automationWorkItemId,
      title: taskSuggestions.title,
      brief: taskSuggestions.brief,
      category: taskSuggestions.category,
      priority: taskSuggestions.priority,
      investigationContext: taskSuggestions.investigationContext,
      repositoryIds: taskSuggestions.repositoryIds,
      targetRepositoryFullName: taskSuggestions.targetRepositoryFullName,
      targetEnvironmentId: taskSuggestions.targetEnvironmentId,
      readinessMessage: taskSuggestions.readinessMessage,
      sortOrder: taskSuggestions.sortOrder,
    })
    .from(taskSuggestions)
    .where(eq(taskSuggestions.id, suggestionId))
    .limit(1);

  if (!suggestion) {
    return false;
  }

  let suggestionWorkspace: SuggestionLaunchWorkspace | null = null;
  let launchFailureReason: string | null = null;

  if (suggestionMessage.agentType === 'setup_onboarding') {
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
        suggestion.repositoryIds,
        setupNewState.selectedRepositoryIds,
      )
    ) {
      apiLogger.debug(
        `${logPrefix} repository selection mismatch for suggestionId=${suggestionId}`,
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
      suggestion.targetRepositoryFullName?.trim() || null;

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
    } else if (suggestion.repositoryIds.length > 1) {
      launchFailureReason =
        "I couldn't start this setup suggestion because it was generated before per-idea launch targeting was saved. Regenerate the setup suggestions and react again.";
    } else {
      suggestionWorkspace = {
        repoForPayload: matchingEnvironment.repoForPayload,
        environmentId: matchingEnvironment.id,
        workspaceDisplayName: matchingEnvironment.name,
      };
    }
  } else if (suggestionMessage.agentType === 'suggested_tasks') {
    const resolved = await resolveSuggestionLaunchWorkspaceFromMetadata({
      targetRepositoryFullName: suggestion.targetRepositoryFullName,
      targetEnvironmentId: suggestion.targetEnvironmentId,
      readinessMessage: suggestion.readinessMessage,
    });
    suggestionWorkspace = resolved.workspace;
    launchFailureReason = resolved.failureReason;
  } else {
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
        category: suggestion.category,
        priority: suggestion.priority,
      })}${suggestion.title}`,
      brief: suggestion.brief,
      reason: REMOVED_SLACK_ACCOUNT_LAUNCH_FAILURE,
    });
    return true;
  }

  const didClaimSuggestionLaunch = await claimTaskSuggestionLaunch(
    suggestionMessage.id,
  );

  if (!didClaimSuggestionLaunch) {
    return true;
  }

  if (!suggestionWorkspace) {
    if (didClaimSuggestionLaunch) {
      await db
        .update(agentSuggestionMessages)
        .set({ launchClaimedAt: null })
        .where(eq(agentSuggestionMessages.id, suggestionMessage.id));
    }

    apiLogger.warn(
      `${logPrefix} suggestion launch failed before task start: ${launchFailureReason ?? 'missing launch workspace'}`,
    );

    if (launchFailureReason) {
      await postSuggestionLaunchFailureMessage({
        slack,
        channelId,
        title: `${buildSuggestionBadgePrefix({
          category: suggestion.category,
          priority: suggestion.priority,
        })}${suggestion.title}`,
        brief: suggestion.brief,
        reason: launchFailureReason,
      }).catch((error) => {
        console.warn(
          `${logPrefix} failed to post visible launch failure message: ${formatErrorForLog(error)}`,
        );
      });
    }

    return true;
  }

  const suggestionSlackTargetRepositoryFullName =
    suggestion.targetRepositoryFullName;

  const suggestionSlackText = buildSuggestionSlackText({
    title: suggestion.title,
    brief: suggestion.brief,
    category: suggestion.category,
    priority: suggestion.priority,
    targetRepositoryFullName: suggestionSlackTargetRepositoryFullName,
  });
  const seededSuggestionSlackText = buildSeededSuggestionSlackText(
    suggestionSlackText,
    reactionEvent.user,
  );
  const suggestionTaskPrompt = buildSuggestionTaskPromptText({
    title: suggestion.title,
    brief: suggestion.brief,
    investigationContext: suggestion.investigationContext,
    readinessMessage:
      suggestionWorkspace.readinessMessage ?? suggestion.readinessMessage,
    agentType: suggestionMessage.agentType,
    category: suggestion.category,
    priority: suggestion.priority,
    targetRepositoryFullName: suggestionSlackTargetRepositoryFullName,
  });

  let seededThreadTs: string | undefined;
  let cloudJob: Awaited<ReturnType<typeof startSlackAppMentionTask>> | null =
    null;
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
      await db
        .update(agentSuggestionMessages)
        .set({ launchClaimedAt: null })
        .where(eq(agentSuggestionMessages.id, suggestionMessage.id));
      apiLogger.debug(
        `${logPrefix} failed to seed top-level Slack message; launch canceled`,
      );
      return false;
    }

    // The reacting human is the initiator; the old fallback to the
    // suggestion creator's identity is gone.
    cloudJob = await startSlackAppMentionTask({
      initiator: {
        kind: 'user',
        externalId: reactionEvent.user,
        ...(reactingUserMapping.activeMapping?.userId
          ? { matchedUserId: reactingUserMapping.activeMapping.userId }
          : {}),
      },
      trigger: 'manual',
      channel: channelId,
      teamId,
      slackUserId: reactionEvent.user,
      text: suggestionSlackText,
      agentPromptText: suggestionTaskPrompt,
      ts: seededThreadTs,
      threadTs: seededThreadTs,
      repo: suggestionWorkspace.repoForPayload,
      environmentId: suggestionWorkspace.environmentId,
      readinessMessage: suggestionWorkspace.readinessMessage ?? undefined,
      webPath:
        suggestionMessage.agentType === 'setup_onboarding'
          ? '/setup'
          : undefined,
      ackEmoji,
      completionEmoji,
      queuedStartedMessage: {
        ts: seededThreadTs,
        agentName: AGENT_DISPLAY_NAME,
        initiatingSlackUserId: reactionEvent.user,
        workspaceDisplayName: suggestionWorkspace.workspaceDisplayName,
        workspaceOnly: false,
      },
    });

    const updated = await db
      .update(agentSuggestionMessages)
      .set({
        taskId: cloudJob.taskId,
        launchedThreadTs: seededThreadTs,
        launchedAt: new Date(),
        launchClaimedAt: null,
      })
      .where(
        and(
          eq(agentSuggestionMessages.id, suggestionMessage.id),
          isNull(agentSuggestionMessages.taskId),
        ),
      )
      .returning({ id: agentSuggestionMessages.id });

    if (updated.length === 0) {
      apiLogger.debug(
        `[SlackWebhook] setup suggestion reaction became idempotent for ${channelId}:${messageTs}`,
      );
      return false;
    }

    await markSuggestionLaunchStarted({
      suggestionId,
      automationWorkItemId: suggestion.automationWorkItemId,
      taskId: cloudJob.taskId,
    });

    await postTaskSuggestionStartedMessage({
      slack,
      channelId,
      threadTs: seededThreadTs,
      workspaceName: suggestionWorkspace.workspaceDisplayName,
      cloudJobId: cloudJob.id,
      initiatingSlackUserId: reactionEvent.user,
      taskId: cloudJob.taskId,
    });

    apiLogger.debug(
      `${logPrefix} completed reaction launch lifecycle taskId=${cloudJob.taskId ?? 'null'} launchedThreadTs=${seededThreadTs}`,
    );
    return true;
  } catch (error) {
    if (!cloudJob) {
      if (seededThreadTs) {
        await slack
          .deleteMessage({ channel: channelId, ts: seededThreadTs })
          .catch(() => {});
      }

      await db
        .update(agentSuggestionMessages)
        .set({ launchClaimedAt: null })
        .where(eq(agentSuggestionMessages.id, suggestionMessage.id));
      apiLogger.debug(
        `${logPrefix} reaction launch failed before cloud job start; claim released`,
      );
      throw error;
    }

    const recoveredLaunchState: {
      taskId: string | null;
      launchedAt: Date;
      launchClaimedAt: null;
      launchedThreadTs?: string;
    } = {
      taskId: cloudJob.taskId,
      launchedAt: new Date(),
      launchClaimedAt: null,
    };

    if (seededThreadTs) {
      recoveredLaunchState.launchedThreadTs = seededThreadTs;
    }

    try {
      await db
        .update(agentSuggestionMessages)
        .set(recoveredLaunchState)
        .where(
          and(
            eq(agentSuggestionMessages.id, suggestionMessage.id),
            isNull(agentSuggestionMessages.taskId),
          ),
        );

      await markSuggestionLaunchStarted({
        suggestionId,
        automationWorkItemId: suggestion.automationWorkItemId,
        taskId: cloudJob.taskId,
      });

      apiLogger.debug(
        `${logPrefix} reaction launch recovered after post-enqueue failure taskId=${cloudJob.taskId} launchedThreadTs=${seededThreadTs ?? 'unknown'}`,
      );

      if (seededThreadTs) {
        await postTaskSuggestionStartedMessage({
          slack,
          channelId,
          threadTs: seededThreadTs,
          workspaceName: suggestionWorkspace.workspaceDisplayName,
          cloudJobId: cloudJob.id,
          initiatingSlackUserId: reactionEvent.user,
          taskId: cloudJob.taskId,
        });
      } else {
        console.warn(
          `${logPrefix} recovered launch missing seeded thread ts; started message skipped`,
        );
      }

      apiLogger.debug(
        `${logPrefix} completed reaction launch lifecycle taskId=${cloudJob.taskId ?? 'null'} launchedThreadTs=${seededThreadTs ?? 'unknown'}`,
      );

      return true;
    } catch (recoveryError) {
      try {
        await db
          .update(agentSuggestionMessages)
          .set({ launchClaimedAt: null })
          .where(eq(agentSuggestionMessages.id, suggestionMessage.id));
      } catch (releaseError) {
        console.warn(
          `${logPrefix} failed to release claim after recovery failure: ${formatErrorForLog(releaseError)}`,
        );
      }

      console.warn(
        `${logPrefix} failed to backfill launch tracking after post-enqueue failure; claim released for retry: ${formatErrorForLog(recoveryError)}`,
      );

      throw error;
    }
  }
}

async function getTaskSuggestionReactionState(input: {
  channelId: string;
  messageTs: string;
}): Promise<TaskSuggestionReactionState | null> {
  const [suggestionMessage] = await db
    .select({
      taskId: agentSuggestionMessages.taskId,
      launchClaimedAt: agentSuggestionMessages.launchClaimedAt,
      launchedThreadTs: agentSuggestionMessages.launchedThreadTs,
    })
    .from(agentSuggestionMessages)
    .where(
      and(
        inArray(agentSuggestionMessages.agentType, TASK_SUGGESTION_AGENT_TYPES),
        eq(agentSuggestionMessages.channelId, input.channelId),
        eq(agentSuggestionMessages.messageTs, input.messageTs),
      ),
    )
    .limit(1);

  return suggestionMessage ?? null;
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
  const reactionNames = await resolveSlackReactionNames();

  const isMessageItem = event.item.type === 'message';
  if (!isMessageItem) {
    return;
  }

  const isThumbsUp = isThumbsUpReaction(event.reaction);
  const isSummonReaction = isConfiguredSlackReaction(
    event.reaction,
    reactionNames.summonEmoji,
  );

  if (event.user === context.slackInstallation.botUserId) {
    apiLogger.debug(
      `[SlackWebhook] Ignoring self-reaction from bot user ${event.user} on ${event.item.channel}:${event.item.ts}`,
    );
    return;
  }

  if (isThumbsUp) {
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

    apiLogger.debug(
      `[SlackWebhook] Reaction no-op for ${event.item.channel}:${event.item.ts}`,
    );
  }

  if (!isSummonReaction) {
    return;
  }

  const sourceMessage = await context.slack.getMessage({
    channel: event.item.channel,
    messageTs: event.item.ts,
  });

  if (!sourceMessage) {
    apiLogger.debug(
      `[SlackWebhook] Summon reaction source message unavailable for ${event.item.channel}:${event.item.ts}`,
    );
    return;
  }

  const isRoomoteAuthoredBotMessage =
    sourceMessage.user === context.slackInstallation.botUserId ||
    sourceMessage.app_id === context.slackInstallation.appId;

  if (isRoomoteAuthoredBotMessage) {
    apiLogger.debug(
      `[SlackWebhook] Ignoring summon reaction on Roomote-authored bot message ${event.item.channel}:${event.item.ts}`,
    );
    return;
  }

  if (sourceMessage.text.trim().length === 0 && !sourceMessage.files?.length) {
    apiLogger.debug(
      `[SlackWebhook] Ignoring summon reaction on empty source message ${event.item.channel}:${event.item.ts}`,
    );
    return;
  }

  await handleSlackEntryEvent({
    event: {
      type: 'message',
      channel: event.item.channel,
      user: event.user,
      text: sourceMessage.text,
      ts: sourceMessage.ts,
      thread_ts: sourceMessage.thread_ts ?? sourceMessage.ts,
      app_id: sourceMessage.app_id,
      files: sourceMessage.files,
      attachments: sourceMessage.attachments,
    },
    slackInstallation: context.slackInstallation as never,
    slack: context.slack,
    teamId: context.teamId,
    ackEmoji: reactionNames.ackEmoji,
    completionEmoji: reactionNames.completionEmoji,
    skipThreadFollowupHandling: true,
  });
}
