import { Env } from '@roomote/env';
import {
  AUTO_START_CHANNEL_CACHE_TTL_SECONDS,
  getRedis,
  REDIS_KEYS,
  syncAutoStartChannelCacheBestEffort,
} from '@roomote/redis';
import {
  hasFastAgentSession,
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS,
} from '@roomote/cloud-agents/server';
import {
  autoConfirmRouting,
  collectAndExtractThreadAttachmentTexts,
  collectAndProcessThreadImages,
  fetchThreadMessagesSafe,
  findActiveSlackTaskRun,
  formatSlackRoutingWaitReplyText,
  hasPendingRoutingConfirmation,
  getSlackThreadReplyFooterMessageTs,
  isTargetSlackBotMessage,
  markSlackThreadExplicitMentionRequired,
  resolveSlackReactionNames,
  showConnectAccount,
  showTaskConfiguration,
  handleSlackRoutingCorrection,
  startAutoRoutedSlackTask,
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
import {
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
} from '@roomote/cloud-agents';

import { apiLogger } from '../../../logging.js';
import {
  ROUTING_LOCK_TTL_SECONDS,
  SLACK_ROUTING_LOCK_PREFIX,
} from '../constants.js';
import type { AutomatedSlackAppMentionEvent } from '../types.js';
import { processActiveRunMessage } from './active-run.js';
import {
  isBareFastCommandInvocation,
  isFastCommandInvocation,
  processFastAgentMessage,
  resolveFastAgentEntryMode,
} from './fast-agent.js';
import { createFastAgentTaskLauncher } from './fast-agent-task-launcher.js';
import { processSnapshotResume } from './snapshot-resume.js';
import {
  dispatchSlackThreadFollowUp,
  resolveSlackThreadFollowUpRoute,
} from './thread-follow-up-dispatch.js';
import { processSlackAttachments } from '../helpers/attachments.js';
import { postChannelAutoStartRoutingDebug } from '../helpers/channel-auto-start-routing-debug.js';
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
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';
import {
  compareNumericMessageIds,
  evaluateUnmentionedThreadReplyRouting,
  type UnmentionedThreadHistoryMessage,
} from '../../shared/unmentioned-thread-reply.js';
import { showManualPickerForAutoRouteFallback } from './auto-route-fallback.js';

const REMOVED_EVAL_COMMAND_PATTERN = /^!eval(?:\s|$)/iu;

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

async function runSlackAutoConfirm({
  threadId,
  confirmNonce,
  delayMs = ROUTING_AUTO_CONFIRM_TIMEOUT_MS,
  logContext,
}: {
  threadId: string;
  confirmNonce: string;
  delayMs?: number;
  logContext: string;
}): Promise<void> {
  const runAutoConfirm = async () => {
    try {
      await autoConfirmRouting(threadId, confirmNonce);
    } catch (error) {
      console.error(
        `[AutoConfirm] Failed for ${logContext}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  if (delayMs <= 0) {
    apiLogger.debug(
      `[AutoConfirm] Triggering immediate Slack auto-confirm for ${logContext}`,
    );
    void runAutoConfirm();
    return;
  }

  setTimeout(() => {
    void runAutoConfirm();
  }, delayMs);
}

async function processNewTaskConfiguration(
  event: SlackEvent,
  slackInstallation: SlackInstallation,
  userMapping: SlackUserMapping,
  slack: SlackNotifier,
  processingReactionName: string,
): Promise<void> {
  const threadId = event.thread_ts || event.ts;
  const threadMessagesPromise = event.thread_ts
    ? fetchThreadMessagesSafe({
        fetchThreadMessages: (params) => slack.fetchThreadMessages(params),
        channel: event.channel,
        threadTs: threadId,
        logContext: `new task configuration in ${event.channel}:${threadId}`,
      })
    : Promise.resolve([]);
  const [{ images, attachmentTexts, videoDescriptions }, threadMessages] =
    await Promise.all([
      processSlackAttachments({
        slack,
        files: event.files,
        userId: userMapping.userId,
        userTextContext: stripLeadingSlackProductMention(
          stripLeadingRawSlackMention(event.text),
        ),
      }),
      threadMessagesPromise,
    ]);

  const excludeFileIds = event.files
    ? new Set(event.files.map((file) => file.id))
    : undefined;
  const [threadImages, threadAttachmentTexts] = await Promise.all([
    collectAndProcessThreadImages({
      processSlackFiles: (files) => slack.processSlackFiles(files),
      messages: threadMessages,
      excludeFileIds,
      logContext: `new task configuration in ${event.channel}:${threadId}`,
    }),
    collectAndExtractThreadAttachmentTexts({
      extractSlackAttachmentTexts: async (files) =>
        (
          await processSlackAttachments({
            slack,
            files,
            userId: userMapping.userId,
            userTextContext: stripLeadingSlackProductMention(
              stripLeadingRawSlackMention(event.text),
            ),
          })
        ).attachmentTexts,
      messages: threadMessages,
      excludeFileIds,
      logContext: `new task configuration in ${event.channel}:${threadId}`,
    }),
  ]);

  event.processedImages = [...images, ...threadImages];
  event.processedAttachmentTexts = [
    ...attachmentTexts,
    ...threadAttachmentTexts,
  ];
  event.processedVideoDescriptions = videoDescriptions;

  const result = await showTaskConfiguration({
    event,
    slackInstallation,
    userMapping,
    slack,
    processingReactionName,
  });

  if (result.routingUsed && result.confirmNonce) {
    await runSlackAutoConfirm({
      threadId: result.threadId,
      confirmNonce: result.confirmNonce,
      delayMs: result.autoConfirmDelayMs,
      logContext: `thread ${result.threadId}`,
    });
  }

  apiLogger.debug(
    `✅ Successfully processed task configuration for ${result.threadId}` +
      (result.startedImmediately
        ? ' (task started immediately)'
        : result.routingUsed
          ? result.autoConfirmDelayMs === 0
            ? ' (routing confirmation sent, immediate auto-confirm triggered)'
            : ' (routing confirmation sent, auto-confirm scheduled)'
          : ''),
  );
}

async function processRoutingCorrection(
  event: SlackEvent,
  slackInstallation: SlackInstallation,
  userMapping: SlackUserMapping,
  slack: SlackNotifier,
  processingReactionName: string,
): Promise<void> {
  const threadId = event.thread_ts || event.ts;
  const correctionText = await slack.normalizeIncomingText(
    stripLeadingRawSlackMention(event.text),
  );

  const correctionResult = await handleSlackRoutingCorrection({
    threadId,
    correctionText,
    event,
    slackInstallation,
    userMapping,
    slack,
    processingReactionName,
  });

  if (correctionResult.autoConfirmData) {
    const {
      threadId: confirmThreadId,
      confirmNonce,
      autoConfirmDelayMs,
    } = correctionResult.autoConfirmData;
    await runSlackAutoConfirm({
      threadId: confirmThreadId,
      confirmNonce,
      delayMs: autoConfirmDelayMs,
      logContext: `corrected thread ${confirmThreadId}`,
    });
  }
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

  if (
    mentionsSlackUserOtherThanBotWithoutMentioningBot(
      event,
      slackInstallation.botUserId,
    )
  ) {
    return { shouldRoute: false };
  }

  const pendingRoutingConfirmation = await hasPendingRoutingConfirmation(
    event.thread_ts,
  );
  let roomoteThreadMatch: Awaited<
    ReturnType<typeof findRoomoteOwnedSlackThread>
  > | null = null;

  let eligibilityReason:
    | 'pending-routing-confirmation'
    | 'roomote-owned-thread'
    | null = null;

  if (pendingRoutingConfirmation) {
    eligibilityReason = 'pending-routing-confirmation';
  } else {
    const isFastAgentThread = await hasFastAgentSession({
      slackTeamId: teamId,
      slackChannel: event.channel,
      slackThreadTs: event.thread_ts,
    });

    roomoteThreadMatch = isFastAgentThread
      ? null
      : await findRoomoteOwnedSlackThread({
          teamId,
          channelId: event.channel,
          threadTs: event.thread_ts,
        });

    if (isFastAgentThread || roomoteThreadMatch) {
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
          event.user,
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

async function startNewTaskConfigurationWithLock(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  slack: SlackNotifier;
  threadId: string;
  errorLogPrefix: string;
  processingReactionName: string;
}): Promise<boolean> {
  const redis = getRedis();
  const routingLockKey = `${SLACK_ROUTING_LOCK_PREFIX}${params.threadId}`;
  const routingLockAcquired = await redis.set(
    routingLockKey,
    '1',
    'EX',
    ROUTING_LOCK_TTL_SECONDS,
    'NX',
  );

  if (!routingLockAcquired) {
    apiLogger.debug(
      `🔄 Skipping duplicate routing for thread ${params.threadId} (routing lock held)`,
    );

    if (params.event.thread_ts) {
      await params.slack
        .postMessage({
          channel: params.event.channel,
          thread_ts: params.threadId,
          blocks: [
            {
              type: 'markdown',
              text: formatSlackRoutingWaitReplyText(),
            },
          ],
        })
        .catch((error) => {
          console.warn(
            `[SlackWebhook] Failed to post routing wait message for thread ${params.threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    return false;
  }

  processNewTaskConfiguration(
    params.event,
    params.slackInstallation,
    params.userMapping,
    params.slack,
    params.processingReactionName,
  ).catch(async (error) => {
    await redis.del(routingLockKey).catch(() => {});
    console.error(
      params.errorLogPrefix,
      error instanceof Error ? error.message : String(error),
    );
  });

  return true;
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

  await input.slack
    .postMessage({
      channel: input.channelId,
      thread_ts: input.threadId,
      text: CHANNEL_AUTO_START_FAILURE_MESSAGE,
      blocks: [
        {
          type: 'markdown',
          text: CHANNEL_AUTO_START_FAILURE_MESSAGE,
        },
      ],
    })
    .catch((error) => {
      apiLogger.warn(
        `[SlackWebhook] Failed to post configured channel auto-start launch failure for ${input.channelId}:${input.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

async function postChannelAutoStartRoutingDebugBestEffort(
  input: Parameters<typeof postChannelAutoStartRoutingDebug>[0],
): Promise<void> {
  await postChannelAutoStartRoutingDebug(input).catch((error) => {
    apiLogger.warn(
      `[SlackWebhook] Failed to post configured channel auto-start routing debug for ${input.sourceChannelId}:${input.threadId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export async function processSlackChannelAutoStartTask(params: {
  event: ChannelAutoStartMessageEvent;
  isBotAuthored: boolean;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  userMapping: SlackUserMapping | null;
  teamId: string;
  ackEmoji: string;
  channelAutoStartLaunchMode: ChannelAutoStartLaunchMode;
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
    channelAutoStartLaunchMode,
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
    let channelAutoStartDebug: {
      llmDecision: 'launch' | 'skip' | 'not_run' | 'error';
      reason: string;
    } | null = null;
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

        channelAutoStartDebug = gateResult.debug;

        if (!gateResult.shouldLaunch) {
          await postChannelAutoStartRoutingDebugBestEffort({
            slack,
            sourceChannelId: event.channel,
            sourceChannelName,
            threadId,
            messageText: event.text,
            launchMode: channelAutoStartLaunchMode,
            llmDecision: gateResult.debug.llmDecision,
            llmReason: gateResult.debug.reason,
            taskOutcome: 'skipped_before_start',
            taskOutcomeDetails: `Launch gate stopped before task startup (${gateResult.skipReason}).`,
          });
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

      if (humanUserMapping && typeof event.user === 'string') {
        await recordInboundSlackConversationMessage({
          event: { ...event, user: event.user },
          slack,
          userMapping: humanUserMapping,
          teamId,
          shouldRecordThreadReply: false,
        });
      }

      await redis.sadd(REDIS_KEYS.MENTIONED_THREADS, threadId);
      await slack.addReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: ackEmoji,
      });

      const { images, attachmentTexts, videoDescriptions } =
        await processSlackAttachments({
          slack,
          files: event.files,
          userId: launchIdentity.launchUserId,
          userTextContext: stripLeadingSlackProductMention(
            stripLeadingRawSlackMention(event.text),
          ),
        });

      // Bot-authored auto-starts are automation-initiated with no installer
      // owner; a human posting in a configured auto-start channel is the
      // initiating user.
      const initiator: TaskInitiator = isBotAuthored
        ? {
            kind: 'automation',
            key: 'slack_channel_auto_start',
            ...(typeof event.user === 'string'
              ? { actor: { externalId: event.user } }
              : {}),
          }
        : {
            kind: 'user',
            externalId: launchIdentity.slackUserId,
            matchedUserId: launchIdentity.launchUserId,
          };

      const result = await startAutoRoutedSlackTask({
        slackInstallation,
        slack,
        initiator,
        trigger: 'message',
        launchUserId: isBotAuthored ? null : launchIdentity.launchUserId,
        slackUserId: launchIdentity.slackUserId,
        persistedSlackUserId: isBotAuthored ? null : launchIdentity.slackUserId,
        initiatingSlackUserId:
          launchIdentity.slackUserId === slackInstallation.botUserId
            ? undefined
            : launchIdentity.slackUserId,
        channel: event.channel,
        prompt: event.text,
        threadTs: threadId,
        originMessageTs: event.ts,
        processedImages: images.length > 0 ? images : undefined,
        processedImageFileIds: event.files?.map((file) => file.id),
        processedAttachmentFileIds: event.files?.map((file) => file.id),
        ...(attachmentTexts.length > 0
          ? { processedAttachmentTexts: attachmentTexts }
          : {}),
        ...(videoDescriptions.length > 0
          ? { processedVideoDescriptions: videoDescriptions }
          : {}),
        channelAutoStartLaunchMode,
        agentPromptPrefix,
      });

      if (result.status === 'started') {
        if (channelAutoStartDebug) {
          await postChannelAutoStartRoutingDebugBestEffort({
            slack,
            sourceChannelId: event.channel,
            sourceChannelName,
            threadId,
            messageText: event.text,
            launchMode: channelAutoStartLaunchMode,
            llmDecision: channelAutoStartDebug.llmDecision,
            llmReason: channelAutoStartDebug.reason,
            taskOutcome: 'started',
          });
        }
        apiLogger.info(
          `[SlackWebhook] Configured channel auto-start launched task thread_id=${result.threadId} task_run_id=${result.runId} task_id=${result.taskId} channel=${event.channel}`,
        );
        return;
      }

      const failureCode =
        result.status === 'not_started' ? result.code : 'routing_fallback';
      const showedManualPicker = await showManualPickerForAutoRouteFallback({
        result,
        event,
        slackInstallation,
        userMapping: humanUserMapping,
        slack,
        processedImages: images.length > 0 ? images : undefined,
        processedAttachmentTexts:
          attachmentTexts.length > 0 ? attachmentTexts : undefined,
        processedVideoDescriptions:
          videoDescriptions.length > 0 ? videoDescriptions : undefined,
        processingReactionName: ackEmoji,
      });

      if (channelAutoStartDebug) {
        await postChannelAutoStartRoutingDebugBestEffort({
          slack,
          sourceChannelId: event.channel,
          sourceChannelName,
          threadId,
          messageText: event.text,
          launchMode: channelAutoStartLaunchMode,
          llmDecision: channelAutoStartDebug.llmDecision,
          llmReason: channelAutoStartDebug.reason,
          taskOutcome: 'not_started',
          taskOutcomeDetails: showedManualPicker
            ? `${failureCode}: manual picker shown`
            : result.status === 'not_started' &&
                result.code === 'routing_fallback'
              ? `${failureCode}: manual picker unavailable`
              : `${failureCode}: ${result.message}`,
        });
      }
      apiLogger.warn(
        `[SlackWebhook] Configured channel auto-start did not start task code=${failureCode} thread_id=${result.threadId} channel=${event.channel}`,
      );
      if (showedManualPicker) {
        return;
      }

      if (
        result.status === 'not_started' &&
        result.code === 'routing_fallback'
      ) {
        await redis.del(routingLockKey).catch(() => {});
        return;
      }

      await slack.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: result.message,
        blocks: [
          {
            type: 'markdown',
            text: result.message,
          },
        ],
      });
      await redis.del(routingLockKey).catch(() => {});
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (channelAutoStartDebug) {
        await postChannelAutoStartRoutingDebugBestEffort({
          slack,
          sourceChannelId: event.channel,
          sourceChannelName,
          threadId,
          messageText: event.text,
          launchMode: channelAutoStartLaunchMode,
          llmDecision: channelAutoStartDebug.llmDecision,
          llmReason: channelAutoStartDebug.reason,
          taskOutcome: 'not_started',
          taskOutcomeDetails: `Exception after launch gate approval: ${errorMessage}`,
        });
      }

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

  const fastAgentEntryMode =
    userMapping && typeof channelAutoStartEvent.user === 'string'
      ? resolveFastAgentEntryMode({
          explicitInvocation: isBareFastCommandInvocation(
            channelAutoStartEvent.text,
          ),
          deploymentSettingEnabled:
            Env.R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED === true,
          userDefaultEnabled:
            userMapping.communicationsFastModeDefault &&
            !isRemovedEvalCommandInvocation(channelAutoStartEvent.text),
        })
      : null;

  if (fastAgentEntryMode && userMapping) {
    startFastAgentResponse({
      event: { ...channelAutoStartEvent, user: channelAutoStartEvent.user },
      slackInstallation: context.slackInstallation,
      userMapping,
      slack: context.slack,
      userId: userMapping.userId,
      teamId: context.teamId,
      usageText: 'Use `!fast <question>` in this channel.',
      continuation: fastAgentEntryMode === 'default',
      processingReactionName: ackEmoji,
      errorLogPrefix: `❌ Background fast-agent response failed for auto-start thread ${channelAutoStartEvent.ts}:`,
    });

    return true;
  }

  if (
    userMapping &&
    typeof channelAutoStartEvent.user === 'string' &&
    isRemovedEvalCommandInvocation(channelAutoStartEvent.text)
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
    channelAutoStartLaunchMode: channelAutoStartLaunchConfig.launchMode,
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
      const { images, attachmentTexts, videoDescriptions } =
        await processSlackAttachments({
          slack,
          files: event.files,
          userTextContext: stripLeadingSlackProductMention(
            stripLeadingRawSlackMention(event.text),
          ),
        });

      // Automated (bot/relay-authored) @mention: automation initiator with
      // the relay message author as the external actor when available.
      const result = await startAutoRoutedSlackTask({
        slackInstallation,
        slack,
        initiator: {
          kind: 'automation',
          key: 'slack_channel_auto_start',
          ...(typeof event.user === 'string'
            ? { actor: { externalId: event.user } }
            : {}),
        },
        trigger: 'message',
        slackUserId: launchIdentity.slackUserId,
        initiatingSlackUserId:
          launchIdentity.slackUserId === slackInstallation.botUserId
            ? undefined
            : launchIdentity.slackUserId,
        channel: event.channel,
        prompt: event.text,
        threadTs: threadId,
        originMessageTs: event.ts,
        processedImages: images.length > 0 ? images : undefined,
        processedImageFileIds: event.files?.map((file) => file.id),
        processedAttachmentFileIds: event.files?.map((file) => file.id),
        ...(attachmentTexts.length > 0
          ? { processedAttachmentTexts: attachmentTexts }
          : {}),
        skipMcpSetupSuggestion: true,
        ...(videoDescriptions.length > 0
          ? { processedVideoDescriptions: videoDescriptions }
          : {}),
      });

      if (result.status !== 'started') {
        const failureCode =
          result.status === 'not_started' ? result.code : 'replied_inline';
        apiLogger.warn(
          `[SlackWebhook] Automated app_mention did not start task code=${failureCode} thread_id=${result.threadId} channel=${event.channel} app_id=${event.app_id}`,
        );

        const showedManualPicker = await showManualPickerForAutoRouteFallback({
          result,
          event: threadEvent,
          slackInstallation,
          userMapping: { userId: launchIdentity.launchUserId },
          slack,
          processedImages: images.length > 0 ? images : undefined,
          processedAttachmentTexts:
            attachmentTexts.length > 0 ? attachmentTexts : undefined,
          processedVideoDescriptions:
            videoDescriptions.length > 0 ? videoDescriptions : undefined,
        });

        if (showedManualPicker) {
          return true;
        }

        if (
          result.status === 'not_started' &&
          (result.code === 'source_message_inaccessible' ||
            result.code === 'deployment_read_only')
        ) {
          await slack.postMessage({
            channel: event.channel,
            thread_ts: threadId,
            text: result.message,
            blocks: [
              {
                type: 'markdown',
                text: result.message,
              },
            ],
          });
        }

        return false;
      }

      apiLogger.info(
        `[SlackWebhook] Automated app_mention started task thread_id=${result.threadId} task_run_id=${result.runId} task_id=${result.taskId} channel=${event.channel} app_id=${event.app_id}`,
      );

      return true;
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

function startFastAgentResponse(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  usageText?: string;
  continuation?: boolean;
  activeTaskId?: string | null;
  processingReactionName: string;
  errorLogPrefix: string;
}): void {
  const { errorLogPrefix, ...fastAgentParams } = params;

  processFastAgentMessage({
    ...fastAgentParams,
    apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
    launchTask: createFastAgentTaskLauncher(params),
  }).catch((error) => {
    console.error(
      errorLogPrefix,
      error instanceof Error ? error.message : String(error),
    );
  });
}

async function handleSlackEntryEvent(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
  ackEmoji: string;
  completionEmoji: string;
  skipThreadFollowupHandling?: boolean;
  prefetchedThreadMessages?: SlackThreadMessage[];
  threadTaskId?: string;
}): Promise<void> {
  const {
    event,
    slackInstallation,
    slack,
    teamId,
    ackEmoji,
    completionEmoji,
    skipThreadFollowupHandling = false,
    prefetchedThreadMessages,
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

  const fastAgentEntryMode = resolveFastAgentEntryMode({
    explicitInvocation: isFastCommandInvocation(event.text),
    deploymentSettingEnabled:
      Env.R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED === true,
    userDefaultEnabled:
      userMapping.communicationsFastModeDefault &&
      !isRemovedEvalCommandInvocation(event.text),
  });

  if (fastAgentEntryMode) {
    startFastAgentResponse({
      event,
      slackInstallation,
      userMapping,
      slack,
      userId: userMapping.userId,
      teamId,
      activeTaskId: activeRun?.taskId ?? null,
      continuation: fastAgentEntryMode === 'default',
      processingReactionName: ackEmoji,
      errorLogPrefix: `❌ Background fast-agent response failed for thread ${threadId}:`,
    });

    return;
  }

  const isFastAgentContinuation = isRemovedEvalCommandInvocation(event.text)
    ? false
    : await hasFastAgentSession({
        slackTeamId: teamId,
        slackChannel: event.channel,
        slackThreadTs: threadId,
      });

  if (isFastAgentContinuation) {
    startFastAgentResponse({
      event,
      slackInstallation,
      userMapping,
      slack,
      userId: userMapping.userId,
      teamId,
      continuation: true,
      activeTaskId: activeRun?.taskId ?? null,
      processingReactionName: ackEmoji,
      errorLogPrefix: `❌ Background fast-agent continuation failed for thread ${threadId}:`,
    });

    return;
  }

  if (!skipThreadFollowupHandling) {
    const followUpRoute = await resolveSlackThreadFollowUpRoute({
      threadId,
      channelId: event.channel,
      slackTeamId: teamId,
      ...(threadTaskId ? { taskId: threadTaskId } : {}),
      prefetchedActiveRun: activeRun ?? null,
      allowCompletedResume: false,
    });
    const followUpOutcome = await dispatchSlackThreadFollowUp({
      route: followUpRoute,
      slack,
      channel: event.channel,
      threadId,
      onActive: async (activeThreadRun) => {
        apiLogger.debug(
          `Found active task run ${activeThreadRun.id} for thread ${threadId} - queuing message for continuation`,
        );

        processActiveRunMessage(
          event,
          slack,
          userMapping.userId,
          activeThreadRun,
          teamId,
          slackInstallation.botUserId,
          prefetchedThreadMessages,
        ).catch((error) => {
          console.error(
            `❌ Background processing failed for active task run ${activeThreadRun.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
      },
    });

    if (followUpOutcome.kind !== 'fresh') {
      return;
    }

    const pendingConfirmation = await hasPendingRoutingConfirmation(threadId);

    if (pendingConfirmation) {
      apiLogger.debug(
        `Pending routing confirmation found for thread ${threadId} - processing correction in background`,
      );

      processRoutingCorrection(
        event,
        slackInstallation,
        userMapping,
        slack,
        ackEmoji,
      ).catch((error) => {
        console.error(
          `❌ Background routing correction failed for thread ${threadId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

      return;
    }
  } else {
    apiLogger.debug(
      `[SlackWebhook] Treating thread ${threadId} as a fresh summon request; bypassing continuation and correction handling`,
    );
  }

  if (
    event.type === 'app_mention' &&
    isRemovedEvalCommandInvocation(event.text)
  ) {
    await postRemovedEvalCommandMessage({
      event,
      slack,
      userId: userMapping.userId,
      teamId,
    });
    return;
  }

  await slack.addReaction({
    channel: event.channel,
    timestamp: event.ts,
    name: ackEmoji,
  });

  const followUpRoute = await resolveSlackThreadFollowUpRoute({
    threadId,
    channelId: event.channel,
    slackTeamId: teamId,
    ...(threadTaskId ? { taskId: threadTaskId } : {}),
    prefetchedActiveRun: null,
  });
  const startFreshTaskConfiguration = async (errorLogPrefix: string) => {
    await startNewTaskConfigurationWithLock({
      event,
      slackInstallation,
      userMapping,
      slack,
      threadId,
      errorLogPrefix,
      processingReactionName: ackEmoji,
    }).catch((lockError) => {
      console.error(
        `❌ Failed to acquire routing lock for thread ${threadId}:`,
        lockError instanceof Error ? lockError.message : String(lockError),
      );
    });
  };

  await dispatchSlackThreadFollowUp({
    route: followUpRoute,
    slack,
    channel: event.channel,
    threadId,
    onActive: async (activeThreadRun) => {
      apiLogger.debug(
        `Found active task run ${activeThreadRun.id} for thread ${threadId} - queuing message for continuation`,
      );

      processActiveRunMessage(
        event,
        slack,
        userMapping.userId,
        activeThreadRun,
        teamId,
        slackInstallation.botUserId,
        prefetchedThreadMessages,
      ).catch((error) => {
        console.error(
          `❌ Background processing failed for active task run ${activeThreadRun.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    onResume: async (completedRun) => {
      apiLogger.debug(
        `[SlackWebhook] Found completed task run ${completedRun.id} with snapshot ${completedRun.snapshotId} for thread ${threadId} - creating SnapshotResume`,
      );

      void processSnapshotResume(
        event,
        slack,
        completedRun,
        threadId,
        userMapping.userId,
        ackEmoji,
        completionEmoji,
        teamId,
        slackInstallation.botUserId,
      )
        .then(async (handled) => {
          if (handled) {
            return;
          }

          apiLogger.debug(
            `[SlackWebhook] Resume not handled for thread ${threadId} - falling back to new task configuration`,
          );

          await startFreshTaskConfiguration(
            `❌ Background task configuration fallback failed for thread ${threadId}:`,
          );
        })
        .catch(async (error) => {
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
            return;
          }

          console.error(
            `❌ Background snapshot resume failed for thread ${threadId}:`,
            error instanceof Error ? error.message : String(error),
          );

          await startFreshTaskConfiguration(
            `❌ Background task configuration fallback failed for thread ${threadId}:`,
          );
        });

      return { handled: true, value: undefined };
    },
    onFresh: async () => {
      if (followUpRoute.kind === 'fresh') {
        apiLogger.debug(
          `No active task run found for thread ${threadId} - processing in background`,
        );
      }

      await startFreshTaskConfiguration(
        `❌ Background task configuration failed for thread ${threadId}:`,
      );
    },
  });
}

export async function handleMessageOrAppMentionEvent(params: {
  event: SlackEvent;
  context: SlackWebhookContext;
}): Promise<void> {
  const { event, context } = params;
  enrichSlackMessageEvent(event);
  const redis = getRedis();
  if (await maybeHandleChannelAutoStart({ event, context, redis })) {
    return;
  }

  await markHumanMentionedSlackThread({
    event,
    slack: context.slack,
    botUserId: context.slackInstallation.botUserId,
  });

  const automatedAppMentionEvent = isRoutableAutomatedSlackAppMention(
    event,
    context.slackInstallation,
  )
    ? event
    : null;
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
    !unmentionedThreadReplyRouting.shouldRoute
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

  const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();

  await handleSlackEntryEvent({
    event,
    slackInstallation: context.slackInstallation,
    slack: context.slack,
    teamId: context.teamId,
    ackEmoji,
    completionEmoji,
    prefetchedThreadMessages: unmentionedThreadReplyRouting.shouldRoute
      ? unmentionedThreadReplyRouting.threadMessages
      : undefined,
    threadTaskId: unmentionedThreadReplyRouting.shouldRoute
      ? unmentionedThreadReplyRouting.taskId
      : (mentionedThreadAliasTaskId ?? undefined),
  });
}
