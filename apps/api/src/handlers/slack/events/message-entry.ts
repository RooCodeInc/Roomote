import { Env } from '@roomote/env';
import {
  AUTO_START_CHANNEL_CACHE_TTL_SECONDS,
  getRedis,
  REDIS_KEYS,
  syncAutoStartChannelCacheBestEffort,
} from '@roomote/redis';
import {
  FastAgentDurableRetryScheduledError,
  hasFastAgentSession,
} from '@roomote/cloud-agents/server';
import {
  acquireSlackFastRootBindingLock,
  createFastAgentSlackLiveTaskLauncher,
  findActiveSlackTaskRun,
  getSlackThreadReplyFooterMessageTs,
  isTargetSlackBotMessage,
  markSlackThreadExplicitMentionRequired,
  resolveSlackReactionNames,
  showConnectAccount,
  type SlackEvent,
  type SlackNotifier,
  type SlackThreadMessage,
} from '@roomote/slack';
import {
  getBackgroundAgentSettingsForDeployment,
  type SlackInstallation,
  type SlackUserMapping,
} from '@roomote/db/server';
import {
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  type ChannelAutoStartLaunchMode,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  type TaskInitiator,
  isDeploymentReadOnlyError,
} from '@roomote/types';

import { apiLogger } from '../../../logging.js';
import {
  ROUTING_LOCK_TTL_SECONDS,
  SLACK_ROUTING_LOCK_PREFIX,
} from '../constants.js';
import type { AutomatedSlackAppMentionEvent } from '../types.js';
import { processActiveRunMessage } from './active-run.js';
import { processFastAgentMessage } from './fast-agent.js';
import {
  resolveFastAgentEntryMode,
  startAcceptedFastAgentTurn,
  type FastAgentStartResult,
} from '../../fast-agent-entry.js';
import { processSnapshotResume } from './snapshot-resume.js';
import {
  dispatchSlackThreadFollowUp,
  resolveSlackThreadFollowUpRoute,
} from './thread-follow-up-dispatch.js';
import {
  findRoomoteOwnedSlackThread,
  findTrackedBackgroundAutomationSlackThread,
  isRoomoteOwnedSlackThread,
  recordInboundSlackConversationMessage,
} from '../helpers/conversation-log.js';
import { getSlackAutomationLaunchIdentity } from '../helpers/launch-identity.js';
import { checkAutoStartChannelCache } from '../../shared/auto-start-cache.js';
import {
  CHANNEL_AUTO_START_FAILURE_MESSAGE,
  evaluateChannelLaunchGate,
} from '../../shared/channel-launch-gate.js';
import type { SlackWebhookContext } from '../context.js';
import {
  enrichSlackMessageEvent,
  isRoomoteAuthoredSlackEvent,
  isRoutableAutomatedSlackAppMention,
} from '../helpers/event-normalization.js';
import {
  mentionsSlackBot,
  mentionsSlackUserOtherThanBot,
  mentionsSlackUserOtherThanBotOrUser,
  mentionsSlackUserOtherThanBotWithoutMentioningBot,
} from '../helpers/mention-routing.js';
import { postSlackThreadMarkdownMessage } from '../helpers/thread-posting.js';
import { resolveFastAgentReplyTasks } from '../pr-review-retire.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';
import {
  compareNumericMessageIds,
  evaluateUnmentionedThreadReplyRouting,
  type UnmentionedThreadHistoryMessage,
} from '../../shared/unmentioned-thread-reply.js';

const REMOVED_EVAL_COMMAND_PATTERN = /^!eval(?:\s|$)/iu;

async function hasBoundSlackFastAgentSession(params: {
  teamId: string;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  const releaseRootBindingLock = await acquireSlackFastRootBindingLock({
    teamId: params.teamId,
    channelId: params.channelId,
  });
  try {
    return await hasFastAgentSession({
      surface: 'slack',
      workspaceId: params.teamId,
      conversationId: params.threadId,
      replyTarget: {
        channelId: params.channelId,
        threadId: params.threadId,
      },
    });
  } finally {
    await releaseRootBindingLock().catch(() => {});
  }
}

export function isRemovedEvalCommandInvocation(text: string): boolean {
  const mentionStrippedText = text
    .replace(/^\s*<@[^>]+>[\s,:;.-]*/u, '')
    .trimStart();
  return REMOVED_EVAL_COMMAND_PATTERN.test(mentionStrippedText);
}

async function postRemovedEvalCommandMessage(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
}): Promise<void> {
  await postSlackThreadMarkdownMessage({
    slack: params.slack,
    channel: params.event.channel,
    threadTs: params.event.thread_ts || params.event.ts,
    text: 'The `!eval` command is no longer available.',
    sourceMessageTs: params.event.ts,
    conversationLog: {
      userId: params.userId,
      slackTeamId: params.teamId,
      source: 'slack_eval_command',
    },
  });
}

type UnmentionedSlackThreadReplyRoutingDecision =
  | { shouldRoute: false }
  | {
      shouldRoute: true;
      threadMessages: SlackThreadMessage[];
      taskId?: string;
    };

function getGroupSlackThreadReplyFooterText(text: string): string {
  const genericMatch = text.match(
    /^_Reply(?: with @-mention)? or use the (<[^>]+\|web app>)\._$/,
  );

  if (genericMatch?.[1]) {
    return `_Reply with @-mention or use the ${genericMatch[1]}._`;
  }

  return text.replace(
    /^_(Working on (?:<[^>]+\|PR(?:\s+#)?\d+>(?:, <[^>]+\|live preview>)?|a <[^>]+\|live preview>)), reply(?: with @-mention)? or use the (<[^>]+\|web app>)\._$/,
    '_$1, reply with @-mention or use the $2._',
  );
}

function updateSlackThreadReplyFooterBlocksForGroupThread(
  blocks: unknown[] | null,
): { blocks: unknown[]; updated: boolean } | null {
  if (!blocks) {
    return null;
  }

  let updated = false;
  const nextBlocks = blocks.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return block;
    }

    const record = block as {
      block_id?: unknown;
      elements?: unknown;
      text?: unknown;
    };

    if (record.block_id !== 'roomote_thread_reply_footer') {
      return block;
    }

    if (!Array.isArray(record.elements)) {
      return block;
    }

    const nextElements = record.elements.map((element) => {
      if (!element || typeof element !== 'object' || Array.isArray(element)) {
        return element;
      }

      const elementRecord = element as { text?: unknown };
      if (typeof elementRecord.text !== 'string') {
        return element;
      }

      const nextText = getGroupSlackThreadReplyFooterText(elementRecord.text);

      if (nextText === elementRecord.text) {
        return element;
      }

      updated = true;
      return { ...elementRecord, text: nextText };
    });

    return { ...record, elements: nextElements };
  });

  return { blocks: nextBlocks, updated };
}

async function updateSlackThreadReplyFooterForGroupThread(params: {
  event: SlackEvent;
  slack: SlackNotifier;
}): Promise<void> {
  if (!params.event.thread_ts) {
    return;
  }

  const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
    params.event.channel,
    params.event.thread_ts,
  );

  if (!footerMessageTs) {
    return;
  }

  const footerBlocks = updateSlackThreadReplyFooterBlocksForGroupThread(
    await params.slack.getMessageBlocks({
      channel: params.event.channel,
      messageTs: footerMessageTs,
      threadTs: params.event.thread_ts,
    }),
  );

  if (!footerBlocks?.updated) {
    return;
  }

  await params.slack.updateMessage({
    channel: params.event.channel,
    ts: footerMessageTs,
    message: { blocks: footerBlocks.blocks },
  });
}

async function markExplicitMentionRequiredSlackThread(params: {
  event: SlackEvent;
  slack: SlackNotifier;
}): Promise<void> {
  if (!params.event.thread_ts) {
    return;
  }

  await markSlackThreadExplicitMentionRequired(
    params.event.channel,
    params.event.thread_ts,
  );

  try {
    await updateSlackThreadReplyFooterForGroupThread({
      event: params.event,
      slack: params.slack,
    });
  } catch (error) {
    console.error(
      `[SlackWebhook] Failed to update thread reply footer after human mention in ${params.event.channel}:${params.event.thread_ts}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function markHumanMentionedSlackThread(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  botUserId: string | null | undefined;
}): Promise<void> {
  if (!mentionsSlackUserOtherThanBot(params.event, params.botUserId)) {
    return;
  }

  await markExplicitMentionRequiredSlackThread(params);
}

export async function shouldRouteUnmentionedSlackThreadReplyToAgent(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  slackInstallation: SlackInstallation;
  teamId: string;
}): Promise<UnmentionedSlackThreadReplyRoutingDecision> {
  const { event, slack, slackInstallation, teamId } = params;

  if (
    event.type !== 'message' ||
    event.channel_type === 'im' ||
    !event.thread_ts ||
    !event.user
  ) {
    return { shouldRoute: false };
  }

  if (event.subtype && event.subtype !== 'file_share') {
    return { shouldRoute: false };
  }

  if (
    event.subtype === 'bot_message' ||
    isRoomoteAuthoredSlackEvent(event, slackInstallation)
  ) {
    return { shouldRoute: false };
  }

  if (mentionsSlackBot(event, slackInstallation.botUserId)) {
    return { shouldRoute: false };
  }

  // A bound Session decides whether to answer; human conversation history
  // must not prevent it from receiving follow-ups while a turn is busy.
  if (
    await hasBoundSlackFastAgentSession({
      teamId,
      channelId: event.channel,
      threadId: event.thread_ts,
    })
  ) {
    return { shouldRoute: true, threadMessages: [] };
  }

  if (
    mentionsSlackUserOtherThanBotWithoutMentioningBot(
      event,
      slackInstallation.botUserId,
    )
  ) {
    return { shouldRoute: false };
  }

  let roomoteThreadMatch: Awaited<
    ReturnType<typeof findRoomoteOwnedSlackThread>
  > | null = null;

  let eligibilityReason: 'roomote-owned-thread' | null = null;

  {
    roomoteThreadMatch = await findRoomoteOwnedSlackThread({
      teamId,
      channelId: event.channel,
      threadTs: event.thread_ts,
    });

    const taskThreadRoute = roomoteThreadMatch
      ? null
      : await resolveSlackThreadFollowUpRoute({
          threadId: event.thread_ts,
          channelId: event.channel,
          slackTeamId: teamId,
        });

    if (
      roomoteThreadMatch ||
      (taskThreadRoute && taskThreadRoute.kind !== 'fresh')
    ) {
      eligibilityReason = 'roomote-owned-thread';
    }
  }

  if (!eligibilityReason) {
    return { shouldRoute: false };
  }

  const threadMessages = await slack
    .fetchThreadMessages({
      channel: event.channel,
      threadTs: event.thread_ts,
    })
    .catch(() => {
      return null;
    });

  // `fetchThreadMessages` returns an empty array when the Slack API call
  // fails, and a real thread always contains at least its root message, so an
  // empty result means the history is unreliable. Require an explicit mention
  // instead of routing blind.
  if (!threadMessages || threadMessages.length === 0) {
    return { shouldRoute: false };
  }

  const botUserId = slackInstallation.botUserId ?? undefined;
  const isThreadTaskOwner =
    Boolean(roomoteThreadMatch?.slackUserId) &&
    roomoteThreadMatch?.slackUserId === event.user;
  const isThreadRootAuthor = threadMessages.some(
    (message) =>
      message.ts === event.thread_ts &&
      !message.bot_id &&
      message.user === event.user,
  );

  const sharedHistory: UnmentionedThreadHistoryMessage[] = threadMessages.map(
    (message) => {
      const isBot = isTargetSlackBotMessage(message, botUserId);
      const isHumanAuthored =
        !message.bot_id && Boolean(message.user) && message.user !== botUserId;
      return {
        id: message.ts,
        authorUserId: isHumanAuthored ? message.user : isBot ? botUserId : null,
        isBot,
        mentionsBot: mentionsSlackBot(message, slackInstallation.botUserId),
        mentionsSomebodyElse: mentionsSlackUserOtherThanBotOrUser(
          message,
          slackInstallation.botUserId,
          message.user,
        ),
      };
    },
  );

  // Shared Slack/Discord/Teams core: eligibility (owner/root/prior mention)
  // and the interjection window since the bot's last reply.
  const decision = evaluateUnmentionedThreadReplyRouting({
    eventMessageId: event.ts,
    senderUserId: event.user,
    isThreadTaskOwner,
    isThreadRootAuthor,
    isAutomationReportThread: Boolean(
      roomoteThreadMatch?.isAutomationReportThread,
    ),
    threadMessages: sharedHistory,
    compareMessageIds: compareNumericMessageIds,
  });

  if (!decision.shouldRoute) {
    if (decision.interjectionDetected) {
      await markExplicitMentionRequiredSlackThread({
        event,
        slack,
      });
    }
    return { shouldRoute: false };
  }

  return {
    shouldRoute: true,
    threadMessages,
    ...(roomoteThreadMatch?.trackedAliasTaskId
      ? { taskId: roomoteThreadMatch.trackedAliasTaskId }
      : {}),
  };
}

export async function resolveMentionedSlackThreadAliasTaskId(params: {
  event: SlackEvent;
  botUserId: string;
  teamId: string;
}): Promise<string | null> {
  const { event } = params;
  if (
    !event.thread_ts ||
    (event.type !== 'app_mention' && !mentionsSlackBot(event, params.botUserId))
  ) {
    return null;
  }

  const match = await findRoomoteOwnedSlackThread({
    teamId: params.teamId,
    channelId: event.channel,
    threadTs: event.thread_ts,
  });
  return match?.trackedAliasTaskId ?? null;
}

async function maybeRecordTrackedAutomationThreadReply(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  slackInstallation: SlackInstallation;
  teamId: string;
}): Promise<void> {
  const { event, slack, slackInstallation, teamId } = params;

  if (
    event.type !== 'message' ||
    event.channel_type === 'im' ||
    !event.thread_ts ||
    !event.user
  ) {
    return;
  }

  if (
    event.subtype &&
    event.subtype !== 'file_share' &&
    event.subtype !== 'bot_message'
  ) {
    return;
  }

  if (
    event.subtype === 'bot_message' ||
    isRoomoteAuthoredSlackEvent(event, slackInstallation)
  ) {
    return;
  }

  const trackedThread = await findTrackedBackgroundAutomationSlackThread({
    teamId,
    channelId: event.channel,
    threadTs: event.thread_ts,
  });

  if (!trackedThread) {
    return;
  }

  const { activeMapping: userMapping } = await lookupSlackUserMapping({
    slackUserId: event.user,
    teamId,
  });

  await recordInboundSlackConversationMessage({
    event,
    slack,
    userMapping: userMapping ?? null,
    teamId,
    shouldRecordThreadReply: true,
  });
}

async function postSlackChannelAutoStartFailureBestEffort(input: {
  slack: SlackNotifier;
  channelId: string;
  threadId: string;
  isBotAuthored: boolean;
}): Promise<void> {
  // Bot-authored messages are typically automated feeds; a "please try
  // again" reply is addressed to nobody, and a sustained classifier or
  // startup outage would otherwise reply to every feed message. Failures on
  // bot messages stay log-only, like before launch-failure replies existed.
  if (input.isBotAuthored) {
    return;
  }

  try {
    await input.slack.postMessage({
      channel: input.channelId,
      thread_ts: input.threadId,
      text: CHANNEL_AUTO_START_FAILURE_MESSAGE,
      blocks: [
        {
          type: 'markdown',
          text: CHANNEL_AUTO_START_FAILURE_MESSAGE,
        },
      ],
    });
  } catch (error) {
    apiLogger.warn(
      `[SlackWebhook] Failed to post configured channel auto-start launch failure for ${input.channelId}:${input.threadId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function processSlackChannelAutoStartTask(params: {
  event: ChannelAutoStartMessageEvent;
  isBotAuthored: boolean;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  userMapping: SlackUserMapping | null;
  teamId: string;
  ackEmoji: string;
  agentPromptPrefix?: string;
  launchCriteria?: string | null;
}): Promise<boolean> {
  const {
    event,
    isBotAuthored,
    slackInstallation,
    slack,
    userMapping,
    teamId,
    ackEmoji,
    agentPromptPrefix,
    launchCriteria,
  } = params;
  const threadId = event.ts;
  const humanUserMapping =
    !isBotAuthored && typeof event.user === 'string' ? userMapping : null;

  const launchIdentity = isBotAuthored
    ? await getSlackAutomationLaunchIdentity({
        slackInstallation,
        teamId,
      })
    : humanUserMapping
      ? {
          launchUserId: humanUserMapping.userId,
          slackUserId: humanUserMapping.slackUserId,
        }
      : null;

  if (!launchIdentity) {
    apiLogger.debug(
      `[SlackWebhook] Skipping configured channel auto-start for ${event.channel}:${threadId} because the Slack user is not linked`,
    );
    return true;
  }

  const redis = getRedis();
  const routingLockKey = `${SLACK_ROUTING_LOCK_PREFIX}${threadId}`;
  const routingLockAcquired = await redis.set(
    routingLockKey,
    '1',
    'EX',
    ROUTING_LOCK_TTL_SECONDS,
    'NX',
  );

  if (!routingLockAcquired) {
    apiLogger.debug(
      `🔄 Skipping duplicate configured-channel auto-start for thread ${threadId} (routing lock held)`,
    );
    return false;
  }

  void (async () => {
    let sourceChannelName: string | null = null;

    try {
      if (launchCriteria) {
        sourceChannelName =
          (await slack.getChannelName?.(event.channel)) ?? null;
        const normalizedLaunchGateText = await slack
          .normalizeIncomingText(event.text)
          .catch((error) => {
            apiLogger.warn(
              `[SlackWebhook] Could not normalize configured channel auto-start launch-gate text for ${event.channel}:${threadId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return event.text;
          });
        const gateResult = await evaluateChannelLaunchGate({
          redis,
          provider: 'slack',
          channelId: event.channel,
          channelName: sourceChannelName,
          messageText: normalizedLaunchGateText,
          botMentioned: mentionsSlackBot(event, slackInstallation.botUserId),
          launchCriteria,
          isBotAuthored,
          logContext: `configured channel auto-start ${event.channel}:${threadId}`,
        });

        if (!gateResult.shouldLaunch) {
          // Release the routing lock like other no-launch outcomes so a
          // manual @roomote mention in this thread is not blocked for the
          // remainder of the lock TTL.
          // `rate_limited` stays silent on purpose: a capped channel is
          // already at its launch budget, and per-message replies there would
          // only add noise on top of an intentional throttle.
          if (gateResult.skipReason === 'classifier_error') {
            await postSlackChannelAutoStartFailureBestEffort({
              slack,
              channelId: event.channel,
              threadId,
              isBotAuthored,
            });
          }
          await redis.del(routingLockKey).catch(() => {});
          return;
        }
      }

      // Every post in a configured channel enters Fast: a linked person under
      // their own identity, a bot or webhook feed under the automation launch
      // identity. The channel's instructions ride along as model context. The
      // launch gate above already decided the message warrants a response.
      const instructionContext = agentPromptPrefix?.trim();
      const fastEvent = {
        ...event,
        user: launchIdentity.slackUserId,
        ...(instructionContext
          ? {
              agentContext: [instructionContext, event.agentContext]
                .filter((part): part is string => Boolean(part))
                .join('\n\n'),
            }
          : {}),
      };
      if (humanUserMapping && typeof event.user === 'string') {
        await recordInboundSlackConversationMessage({
          event: { ...event, user: event.user },
          slack,
          userMapping: humanUserMapping,
          teamId,
          shouldRecordThreadReply: false,
        });
      }
      const fastStart = await startFastAgentResponse({
        event: fastEvent,
        slackInstallation,
        ...(humanUserMapping ? { userMapping: humanUserMapping } : {}),
        slack,
        userId: launchIdentity.launchUserId,
        teamId,
        directedAtRoomote:
          !isBotAuthored ||
          mentionsSlackBot(event, slackInstallation.botUserId),
        ...(isBotAuthored
          ? {
              delegatedTaskInitiator: {
                kind: 'automation',
                key: 'slack_channel_auto_start',
                ...(typeof event.user === 'string'
                  ? { actor: { externalId: event.user } }
                  : {}),
              },
            }
          : {}),
        processingReactionName: ackEmoji,
        errorLogPrefix: `❌ Background fast-agent response failed for configured channel auto-start thread ${threadId}:`,
      });

      if (fastStart.accepted) {
        apiLogger.info(
          `[SlackWebhook] Configured channel auto-start routed to Fast thread_id=${threadId} channel=${event.channel}`,
        );
        return;
      }
      apiLogger.warn(
        `[SlackWebhook] Configured channel auto-start Fast entry not accepted (${fastStart.reason}) for thread ${threadId}`,
      );
      await postSlackChannelAutoStartFailureBestEffort({
        slack,
        channelId: event.channel,
        threadId,
        isBotAuthored,
      });
      await redis.del(routingLockKey).catch(() => {});
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await redis.del(routingLockKey).catch(() => {});
      console.error(
        `❌ Configured channel auto-start failed for thread ${threadId}:`,
        errorMessage,
      );
      await postSlackChannelAutoStartFailureBestEffort({
        slack,
        channelId: event.channel,
        threadId,
        isBotAuthored,
      });
    }
  })();

  return true;
}

async function maybeHandleChannelAutoStart(params: {
  event: SlackEvent;
  context: SlackWebhookContext;
  redis: ReturnType<typeof getRedis>;
}): Promise<boolean> {
  const { event, context, redis } = params;
  const channelAutoStartEvent = isChannelAutoStartMessageEvent(event)
    ? event
    : null;

  if (!channelAutoStartEvent) {
    return false;
  }

  if (
    isRoomoteAuthoredSlackEvent(
      channelAutoStartEvent,
      context.slackInstallation,
    )
  ) {
    return false;
  }

  const slackAutoStartChannelCacheKey = REDIS_KEYS.SLACK_AUTO_START_CHANNEL;
  const channelAutoStartCacheResult = await checkAutoStartChannelCache({
    redis,
    cacheKey: slackAutoStartChannelCacheKey,
    channelId: channelAutoStartEvent.channel,
    logContext: 'SlackWebhook',
  });

  if (channelAutoStartCacheResult.status === 'empty') {
    return false;
  }

  const backgroundAgentSettings =
    await getBackgroundAgentSettingsForDeployment();
  const configuredAutoStartTargets =
    backgroundAgentSettings.channelAutoStartEnabled
      ? (backgroundAgentSettings.channelAutoStartSlackChannels?.length ?? 0) > 0
        ? backgroundAgentSettings.channelAutoStartSlackChannels
        : backgroundAgentSettings.channelAutoStartSlackChannelIds.map(
            (channelId, index) => ({
              channelId,
              instructions:
                index === 0
                  ? (backgroundAgentSettings.channelAutoStartInstructions ??
                    null)
                  : null,
              launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
              launchCriteria: null,
            }),
          )
      : [];
  const configuredAutoStartChannelIds = configuredAutoStartTargets.map(
    ({ channelId }) => channelId,
  );
  const shouldRefreshCache =
    channelAutoStartCacheResult.status === 'legacy' ||
    channelAutoStartCacheResult.status === 'mismatch' ||
    channelAutoStartCacheResult.status === 'miss' ||
    (channelAutoStartCacheResult.status === 'hit' &&
      !configuredAutoStartChannelIds.includes(channelAutoStartEvent.channel));

  if (shouldRefreshCache) {
    void syncAutoStartChannelCacheBestEffort({
      redis,
      key: slackAutoStartChannelCacheKey,
      channelIds: configuredAutoStartChannelIds,
      onError: (error) => {
        apiLogger.warn(
          `[SlackWebhook] Failed to sync auto-start channel cache (ttl ${AUTO_START_CHANNEL_CACHE_TTL_SECONDS}s): ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  if (
    !backgroundAgentSettings.channelAutoStartEnabled ||
    !configuredAutoStartChannelIds.includes(channelAutoStartEvent.channel)
  ) {
    return false;
  }

  const matchedChannelAutoStart = configuredAutoStartTargets.find(
    ({ channelId }) => channelId === channelAutoStartEvent.channel,
  );

  const isBotAuthoredChannelAutoStartEvent =
    channelAutoStartEvent.subtype === 'bot_message' ||
    typeof channelAutoStartEvent.user !== 'string' ||
    typeof channelAutoStartEvent.app_id === 'string' ||
    typeof channelAutoStartEvent.bot_id === 'string';
  const userMapping =
    !isBotAuthoredChannelAutoStartEvent &&
    typeof channelAutoStartEvent.user === 'string'
      ? (
          await lookupSlackUserMapping({
            slackUserId: channelAutoStartEvent.user,
            teamId: context.teamId,
          })
        ).activeMapping
      : null;

  if (!userMapping && !isBotAuthoredChannelAutoStartEvent) {
    apiLogger.debug(
      `[SlackWebhook] Slack user is not linked for configured channel auto-start ${event.channel}:${event.ts}; prompting account link`,
    );
    const slackUserId = channelAutoStartEvent.user;
    await showConnectAccount(
      { ...channelAutoStartEvent, user: slackUserId as string },
      context.slackInstallation,
      context.slack,
    );
    return true;
  }

  const { ackEmoji } = await resolveSlackReactionNames();

  if (
    userMapping &&
    typeof channelAutoStartEvent.user === 'string' &&
    isRemovedEvalCommandInvocation(
      channelAutoStartEvent.authoredText ?? channelAutoStartEvent.text,
    )
  ) {
    await postRemovedEvalCommandMessage({
      event: channelAutoStartEvent,
      slack: context.slack,
      userId: userMapping.userId,
      teamId: context.teamId,
    });
    return true;
  }

  const channelAutoStartLaunchConfig = resolveChannelAutoStartLaunchConfig({
    launchMode: matchedChannelAutoStart?.launchMode,
    instructions: matchedChannelAutoStart?.instructions,
  });

  const started = await processSlackChannelAutoStartTask({
    event: channelAutoStartEvent,
    isBotAuthored: isBotAuthoredChannelAutoStartEvent,
    slackInstallation: context.slackInstallation,
    slack: context.slack,
    userMapping,
    teamId: context.teamId,
    ackEmoji,
    agentPromptPrefix: channelAutoStartLaunchConfig.agentPromptPrefix,
    launchCriteria: matchedChannelAutoStart?.launchCriteria ?? null,
  });

  return started;
}

function resolveChannelAutoStartLaunchMode(
  launchMode: ChannelAutoStartLaunchMode | null | undefined,
): ChannelAutoStartLaunchMode {
  return launchMode ?? DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE;
}

function resolveChannelAutoStartLaunchConfig(params: {
  launchMode: ChannelAutoStartLaunchMode | null | undefined;
  instructions: string | null | undefined;
}): {
  launchMode: ChannelAutoStartLaunchMode;
  agentPromptPrefix?: string;
} {
  const launchMode = resolveChannelAutoStartLaunchMode(params.launchMode);

  return {
    launchMode,
    agentPromptPrefix: params.instructions ?? undefined,
  };
}

type ChannelAutoStartMessageEvent = Omit<SlackEvent, 'type' | 'user'> & {
  type: 'message';
  user?: string;
};

function isChannelAutoStartMessageEvent(
  event: SlackEvent | ChannelAutoStartMessageEvent,
): event is ChannelAutoStartMessageEvent {
  return (
    event.type === 'message' &&
    event.channel_type !== 'im' &&
    !event.thread_ts &&
    (!event.subtype ||
      event.subtype === 'file_share' ||
      event.subtype === 'bot_message')
  );
}

async function processAutomatedAppMentionTask(params: {
  event: AutomatedSlackAppMentionEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
}): Promise<boolean> {
  const { event, slackInstallation, slack, teamId } = params;
  const launchIdentity = await getSlackAutomationLaunchIdentity({
    slackInstallation,
    teamId,
  });
  const threadId = event.thread_ts || event.ts;
  const threadEvent = {
    ...event,
    user: launchIdentity.slackUserId,
  };
  const followUpRoute = await resolveSlackThreadFollowUpRoute({
    threadId,
    channelId: event.channel,
    slackTeamId: teamId,
  });
  const followUpOutcome = await dispatchSlackThreadFollowUp<boolean>({
    route: followUpRoute,
    slack,
    channel: event.channel,
    threadId,
    onActive: async (activeRun) => {
      apiLogger.debug(
        `[SlackWebhook] Automated app_mention found active task run ${activeRun.id} for thread ${threadId} - queuing continuation`,
      );

      processActiveRunMessage(
        threadEvent,
        slack,
        launchIdentity.launchUserId,
        activeRun,
        teamId,
        slackInstallation.botUserId,
      ).catch((error) => {
        console.error(
          `❌ Background processing failed for automated active task run ${activeRun.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

      return true;
    },
    onResume: async (completedRun) => {
      const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();

      try {
        // Automation-driven resume: no acting human on the new run.
        const handled = await processSnapshotResume(
          threadEvent,
          slack,
          completedRun,
          threadId,
          null,
          ackEmoji,
          completionEmoji,
          teamId,
          slackInstallation.botUserId,
        );

        if (handled) {
          apiLogger.info(
            `[SlackWebhook] Automated app_mention resumed completed task thread_id=${threadId} source_task_run_id=${completedRun.id} channel=${event.channel} app_id=${event.app_id}`,
          );
          return { handled: true, value: true };
        }

        apiLogger.debug(
          `[SlackWebhook] Automated app_mention resume not handled for thread ${threadId} - falling back to new task`,
        );
      } catch (error) {
        if (isDeploymentReadOnlyError(error)) {
          await slack.postMessage({
            channel: event.channel,
            thread_ts: threadId,
            text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
            blocks: [
              {
                type: 'markdown',
                text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
              },
            ],
          });
          return { handled: true, value: true };
        }

        console.error(
          `[SlackWebhook] Automated app_mention snapshot resume failed for thread ${threadId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }

      return { handled: false };
    },
    onFresh: async () => {
      // Same first hop as a human mention: give Fast the turn under the
      // automation launch identity and let it delegate coding work itself.
      // The direct task launch below stays as the fallback so an automated
      // ticket is never dropped when the Fast turn cannot start.
      const { ackEmoji } = await resolveSlackReactionNames();
      const { activeMapping: launchUserMapping } =
        launchIdentity.slackUserId === slackInstallation.botUserId
          ? { activeMapping: null }
          : await lookupSlackUserMapping({
              slackUserId: launchIdentity.slackUserId,
              teamId,
            });
      const fastStart = await startFastAgentResponse({
        event: threadEvent,
        slackInstallation,
        ...(launchUserMapping ? { userMapping: launchUserMapping } : {}),
        slack,
        userId: launchIdentity.launchUserId,
        teamId,
        directedAtRoomote: true,
        delegatedTaskInitiator: {
          kind: 'automation',
          key: 'slack_channel_auto_start',
          ...(typeof event.user === 'string'
            ? { actor: { externalId: event.user } }
            : {}),
        },
        resolveActiveTasks: () =>
          resolveFastAgentReplyTasks({
            slack,
            slackTeamId: teamId,
            channelId: event.channel,
            threadTs: threadId,
          }),
        processingReactionName: ackEmoji,
        errorLogPrefix: `❌ Background fast-agent response failed for automated mention thread ${threadId}:`,
      });

      if (fastStart.accepted) {
        apiLogger.info(
          `[SlackWebhook] Automated app_mention routed to Fast thread_id=${threadId} channel=${event.channel} app_id=${event.app_id}`,
        );
        return true;
      }

      // Fast no longer refuses a turn: a busy Session queues or steers the
      // message. Non-acceptance here is an exception before admission, and
      // automated mentions are bot-authored, so like the configured-channel
      // path above it stays log-only rather than replying to a feed.
      apiLogger.warn(
        `[SlackWebhook] Automated app_mention Fast entry not accepted (${fastStart.reason}) for thread ${threadId}`,
      );

      return false;
    },
  });

  return Boolean(followUpOutcome.value);
}

async function startAutomatedAppMentionTaskWithLock(params: {
  event: AutomatedSlackAppMentionEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
}): Promise<boolean> {
  const threadId = params.event.thread_ts || params.event.ts;

  const redis = getRedis();
  const routingLockKey = `${SLACK_ROUTING_LOCK_PREFIX}${threadId}`;
  const routingLockAcquired = await redis.set(
    routingLockKey,
    '1',
    'EX',
    ROUTING_LOCK_TTL_SECONDS,
    'NX',
  );

  if (!routingLockAcquired) {
    apiLogger.debug(
      `🔄 Skipping duplicate automated app_mention routing for thread ${threadId} (routing lock held)`,
    );
    return false;
  }

  processAutomatedAppMentionTask(params)
    .then(async (started) => {
      if (!started) {
        await redis.del(routingLockKey).catch(() => {});
      }
    })
    .catch(async (error) => {
      await redis.del(routingLockKey).catch(() => {});
      console.error(
        `❌ Background automated app_mention task failed for thread ${threadId}:`,
        error instanceof Error ? error.message : String(error),
      );
    });

  return true;
}

export function startFastAgentResponse(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  /** Absent only for automation-identity turns (no linked human author). */
  userMapping?: SlackUserMapping;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  activeTasks?: { taskId: string }[];
  resolveActiveTasks?: () => Promise<{ taskId: string }[]>;
  processingReactionName: string;
  isExistingConversation?: boolean;
  directedAtRoomote?: boolean;
  /** Attribution for tasks Fast delegates from this turn; automation-identity
   * turns pass their automation initiator so delegated work keeps automation
   * provenance instead of appearing installer-initiated. */
  delegatedTaskInitiator?: TaskInitiator;
  errorLogPrefix: string;
}): Promise<FastAgentStartResult> {
  const { errorLogPrefix, delegatedTaskInitiator, ...fastAgentParams } = params;
  return startAcceptedFastAgentTurn({
    run: ({ onAccepted, onRejected }) =>
      processFastAgentMessage({
        ...fastAgentParams,
        roomoteSlackUserId: params.slackInstallation.botUserId ?? undefined,
        apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
        launchTask: createFastAgentSlackLiveTaskLauncher({
          slack: params.slack,
          userId: params.userId,
          teamId: params.teamId,
          ...(delegatedTaskInitiator
            ? { initiator: delegatedTaskInitiator }
            : {}),
          ...(params.slackInstallation.teamDomain
            ? { teamDomain: params.slackInstallation.teamDomain }
            : {}),
          channelId: params.event.channel,
          threadTs: params.event.thread_ts || params.event.ts,
          messageId: params.event.ts,
        }),
        onAccepted,
        onRejected,
      }),
    onError: (error) => {
      if (error instanceof FastAgentDurableRetryScheduledError) {
        // Not a failure: the queue re-runs this turn at the scheduled time.
        console.info(
          `[SlackWebhook] Fast turn parked for a durable retry: ${error.message}`,
        );
        return;
      }
      console.error(
        errorLogPrefix,
        error instanceof Error ? error.message : String(error),
      );
    },
  });
}

async function handleSlackEntryEvent(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
  ackEmoji: string;
  skipThreadFollowupHandling?: boolean;
  threadTaskId?: string;
}): Promise<void> {
  const {
    event,
    slackInstallation,
    slack,
    teamId,
    ackEmoji,
    skipThreadFollowupHandling = false,
    threadTaskId,
  } = params;

  if (!event.user) {
    return;
  }

  const { activeMapping: userMapping } = await lookupSlackUserMapping({
    slackUserId: event.user,
    teamId,
  });

  if (!userMapping) {
    const isPlainChannelThreadReply =
      event.type === 'message' &&
      typeof event.channel_type === 'string' &&
      event.channel_type !== 'im' &&
      Boolean(event.thread_ts);

    if (isPlainChannelThreadReply) {
      await maybeRecordTrackedAutomationThreadReply({
        event,
        slack,
        slackInstallation,
        teamId,
      });
      return;
    }

    await showConnectAccount(event, slackInstallation, slack);
    return;
  }

  const threadId = event.thread_ts || event.ts;

  if (event.type === 'app_mention') {
    apiLogger.debug(
      `🤖 Bot mentioned in channel: ${event.channel} (${threadId})`,
    );
  } else {
    apiLogger.debug(
      event.thread_ts
        ? `🤖 Bot messaged existing thread: ${event.channel} (${threadId})`
        : `🤖 Bot directly messaged: ${event.channel} (${threadId})`,
    );
  }

  const activeRun = skipThreadFollowupHandling
    ? null
    : await findActiveSlackTaskRun(
        threadId,
        threadTaskId
          ? {
              taskId: threadTaskId,
              trackedAlias: {
                slackTeamId: teamId,
                channelId: event.channel,
                threadTs: threadId,
              },
            }
          : { slackTeamId: teamId },
      );
  const shouldRecordThreadReply =
    Boolean(event.thread_ts) &&
    !skipThreadFollowupHandling &&
    (event.type !== 'app_mention' ||
      Boolean(activeRun) ||
      (await isRoomoteOwnedSlackThread({
        teamId,
        channelId: event.channel,
        threadTs: threadId,
      })));

  await recordInboundSlackConversationMessage({
    event,
    slack,
    userMapping,
    teamId,
    shouldRecordThreadReply,
    activeRunId: activeRun?.id,
    activeTaskId: activeRun?.taskId,
  });

  const authoredEventText = event.authoredText ?? event.text;
  const fastAgentEntryMode = resolveFastAgentEntryMode({
    userDefaultEnabled: !isRemovedEvalCommandInvocation(authoredEventText),
  });

  if (fastAgentEntryMode) {
    void startFastAgentResponse({
      event,
      slackInstallation,
      userMapping,
      slack,
      userId: userMapping.userId,
      teamId,
      resolveActiveTasks: () =>
        resolveFastAgentReplyTasks({
          slack,
          slackTeamId: teamId,
          channelId: event.channel,
          threadTs: threadId,
          activeTaskId: activeRun?.taskId,
        }),
      directedAtRoomote: mentionsSlackBot(event, slackInstallation.botUserId),
      processingReactionName: ackEmoji,
      errorLogPrefix: `❌ Background fast-agent response failed for thread ${threadId}:`,
    });

    return;
  }

  // The only message shape that does not enter Fast is the retired `!eval`
  // command, which gets a notice instead of a task.
  await postRemovedEvalCommandMessage({
    event,
    slack,
    userId: userMapping.userId,
    teamId,
  });
}

export async function handleMessageOrAppMentionEvent(params: {
  event: SlackEvent;
  context: SlackWebhookContext;
}): Promise<void> {
  const { event, context } = params;
  enrichSlackMessageEvent(event);
  const automatedAppMentionEvent = isRoutableAutomatedSlackAppMention(
    event,
    context.slackInstallation,
  )
    ? event
    : null;
  const redis = getRedis();
  if (
    !automatedAppMentionEvent &&
    (await maybeHandleChannelAutoStart({ event, context, redis }))
  ) {
    return;
  }

  await markHumanMentionedSlackThread({
    event,
    slack: context.slack,
    botUserId: context.slackInstallation.botUserId,
  });

  const mentionedThreadAliasTaskId =
    await resolveMentionedSlackThreadAliasTaskId({
      event,
      botUserId: context.slackInstallation.botUserId,
      teamId: context.teamId,
    });

  const unmentionedThreadReplyRouting: UnmentionedSlackThreadReplyRoutingDecision =
    event.type === 'message' && event.channel_type !== 'im'
      ? await shouldRouteUnmentionedSlackThreadReplyToAgent({
          event,
          slack: context.slack,
          slackInstallation: context.slackInstallation,
          teamId: context.teamId,
        })
      : { shouldRoute: false };
  const isBotMentionedMessageEvent =
    event.type === 'message' &&
    mentionsSlackBot(event, context.slackInstallation.botUserId);

  if (
    event.type === 'message' &&
    event.channel_type !== 'im' &&
    !unmentionedThreadReplyRouting.shouldRoute &&
    !automatedAppMentionEvent
  ) {
    await maybeRecordTrackedAutomationThreadReply({
      event,
      slack: context.slack,
      slackInstallation: context.slackInstallation,
      teamId: context.teamId,
    });

    if (isBotMentionedMessageEvent) {
      return;
    }

    return;
  }

  if (
    event.subtype &&
    event.subtype !== 'file_share' &&
    !(automatedAppMentionEvent && event.subtype === 'bot_message')
  ) {
    apiLogger.debug(
      `Skipping message with subtype: ${event.subtype} in channel ${event.channel}`,
    );
    return;
  }

  if (automatedAppMentionEvent) {
    await startAutomatedAppMentionTaskWithLock({
      event: automatedAppMentionEvent,
      slackInstallation: context.slackInstallation,
      slack: context.slack,
      teamId: context.teamId,
    });

    return;
  }

  const { ackEmoji } = await resolveSlackReactionNames();

  await handleSlackEntryEvent({
    event,
    slackInstallation: context.slackInstallation,
    slack: context.slack,
    teamId: context.teamId,
    ackEmoji,
    threadTaskId: unmentionedThreadReplyRouting.shouldRoute
      ? unmentionedThreadReplyRouting.taskId
      : (mentionedThreadAliasTaskId ?? undefined),
  });
}
