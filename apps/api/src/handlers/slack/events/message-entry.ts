import { Env } from '@roomote/env';
import {
  getRedis,
  REDIS_KEYS,
  SLACK_AUTO_START_CHANNEL_CACHE_TTL_SECONDS,
  SLACK_AUTO_START_EMPTY_SENTINEL,
  syncSlackAutoStartChannelCacheBestEffort,
} from '@roomote/redis';
import { FeatureFlag } from '@roomote/feature-flags';
import { getFeatureFlagEvaluator } from '@roomote/feature-flags/server';
import { SLACK_AUTO_CONFIRM_TIMEOUT_MS } from '@roomote/cloud-agents/server';
import {
  autoConfirmRouting,
  collectAndExtractThreadAttachmentTexts,
  clearPendingSlackMcpSetupInterrupt,
  collectAndProcessThreadImages,
  fetchThreadMessagesSafe,
  findActiveSlackJob,
  formatSlackRoutingWaitReplyText,
  hasPendingRoutingConfirmation,
  hasPendingSlackMcpSetupInterrupt,
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
  type ChannelAutoStartLaunchMode,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
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
import { processActiveJobMessage } from './active-job.js';
import {
  isBareFastCommandInvocation,
  isFastCommandInvocation,
  processFastAgentMessage,
} from './fast-agent.js';
import {
  buildSlackEvalUnavailableText,
  isBareEvalCommandInvocation,
  isEvalCommandInvocation,
  processEvalCommandMessage,
} from './eval-command.js';
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
import { evaluateChannelLaunchGate } from '../helpers/channel-launch-gate.js';
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
import { showManualPickerForAutoRouteFallback } from './auto-route-fallback.js';

async function runSlackAutoConfirm({
  threadId,
  confirmNonce,
  delayMs = SLACK_AUTO_CONFIRM_TIMEOUT_MS,
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

function isRedisWrongTypeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('WRONGTYPE');
}

type RedisSetCacheResult =
  | { status: 'hit' }
  | { status: 'empty' }
  | { status: 'miss' }
  | { status: 'mismatch' }
  | { status: 'legacy' };

async function hasExpiringAutoStartChannelCache(params: {
  redis: ReturnType<typeof getRedis>;
  cacheKey: string;
}): Promise<boolean> {
  const ttlSeconds = await params.redis.ttl(params.cacheKey);

  if (ttlSeconds >= 0) {
    return true;
  }

  if (ttlSeconds === -1) {
    apiLogger.warn(
      '[SlackWebhook] Found non-expiring auto-start channel cache; treating as cache miss',
    );
  }

  return false;
}

async function checkAutoStartChannelCache(params: {
  redis: ReturnType<typeof getRedis>;
  cacheKey: string;
  channelId: string;
}): Promise<RedisSetCacheResult> {
  try {
    const membership = await params.redis.sismember(
      params.cacheKey,
      params.channelId,
    );

    if (membership === 1) {
      return (await hasExpiringAutoStartChannelCache(params))
        ? { status: 'hit' }
        : { status: 'legacy' };
    }

    const emptySentinelMembership = await params.redis.sismember(
      params.cacheKey,
      SLACK_AUTO_START_EMPTY_SENTINEL,
    );

    if (emptySentinelMembership === 1) {
      return (await hasExpiringAutoStartChannelCache(params))
        ? { status: 'empty' }
        : { status: 'legacy' };
    }

    const count = await params.redis.scard(params.cacheKey);
    if (count === 0) {
      return { status: 'miss' };
    }

    return (await hasExpiringAutoStartChannelCache(params))
      ? { status: 'mismatch' }
      : { status: 'legacy' };
  } catch (error) {
    if (!isRedisWrongTypeError(error)) {
      throw error;
    }

    apiLogger.warn(
      '[SlackWebhook] Found legacy auto-start channel cache key type; treating as cache miss',
    );
    return { status: 'legacy' };
  }
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
  | { shouldRoute: true; threadMessages: SlackThreadMessage[] };

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

  const [pendingRoutingConfirmation, pendingMcpSetupInterrupt] =
    await Promise.all([
      hasPendingRoutingConfirmation(event.thread_ts),
      hasPendingSlackMcpSetupInterrupt(event.thread_ts),
    ]);
  let roomoteThreadMatch: Awaited<
    ReturnType<typeof findRoomoteOwnedSlackThread>
  > | null = null;

  let eligibilityReason:
    | 'pending-routing-confirmation'
    | 'pending-mcp-setup-interrupt'
    | 'roomote-owned-thread'
    | null = null;

  if (pendingRoutingConfirmation) {
    eligibilityReason = 'pending-routing-confirmation';
  } else if (pendingMcpSetupInterrupt) {
    eligibilityReason = 'pending-mcp-setup-interrupt';
  } else {
    roomoteThreadMatch = await findRoomoteOwnedSlackThread({
      teamId,
      channelId: event.channel,
      threadTs: event.thread_ts,
    });

    if (roomoteThreadMatch) {
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

  // Replying to the bot needs no @-mention unless somebody else sent a
  // message or was mentioned since the bot's last message in the thread.
  // Each new bot reply reopens the no-mention window.
  const botUserId = slackInstallation.botUserId ?? undefined;
  const eventTsValue = Number(event.ts);

  // The no-mention flow is limited to senders who are already in conversation
  // with the bot in this thread: the thread's task owner, the thread starter,
  // or someone who @-mentioned the bot earlier in the thread. Drive-by
  // replies from anyone else still require an explicit mention.
  const isThreadTaskOwner =
    Boolean(roomoteThreadMatch?.slackUserId) &&
    roomoteThreadMatch?.slackUserId === event.user;
  const isThreadRootAuthor = threadMessages.some(
    (message) =>
      message.ts === event.thread_ts &&
      !message.bot_id &&
      message.user === event.user,
  );
  const hasMentionedBotEarlierInThread = threadMessages.some((message) => {
    const tsValue = Number(message.ts);

    return (
      Number.isFinite(tsValue) &&
      tsValue < eventTsValue &&
      !message.bot_id &&
      message.user === event.user &&
      mentionsSlackBot(message, slackInstallation.botUserId)
    );
  });

  if (
    !isThreadTaskOwner &&
    !isThreadRootAuthor &&
    !hasMentionedBotEarlierInThread
  ) {
    return { shouldRoute: false };
  }

  let latestBotMessageTsValue: number | null = null;
  for (const message of threadMessages) {
    if (!isTargetSlackBotMessage(message, botUserId)) {
      continue;
    }

    const tsValue = Number(message.ts);
    if (!Number.isFinite(tsValue) || tsValue >= eventTsValue) {
      continue;
    }

    if (latestBotMessageTsValue === null || tsValue > latestBotMessageTsValue) {
      latestBotMessageTsValue = tsValue;
    }
  }

  for (const message of threadMessages) {
    const tsValue = Number(message.ts);

    // When no bot message is identifiable in the fetched history, the whole
    // thread is treated as the window on purpose (conservative: an
    // interjection anywhere in the thread requires an explicit mention).
    if (
      !Number.isFinite(tsValue) ||
      tsValue >= eventTsValue ||
      (latestBotMessageTsValue !== null && tsValue <= latestBotMessageTsValue)
    ) {
      continue;
    }

    const isHumanAuthored =
      !message.bot_id && Boolean(message.user) && message.user !== botUserId;

    if (!isHumanAuthored) {
      continue;
    }

    const isMessageFromSomebodyElse = message.user !== event.user;
    const mentionsSomebodyElse = mentionsSlackUserOtherThanBotOrUser(
      message,
      slackInstallation.botUserId,
      event.user,
    );

    if (isMessageFromSomebodyElse || mentionsSomebodyElse) {
      await markExplicitMentionRequiredSlackThread({
        event,
        slack,
      });
      return { shouldRoute: false };
    }
  }

  return { shouldRoute: true, threadMessages };
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

async function processSlackChannelAutoStartTask(params: {
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
          await postChannelAutoStartRoutingDebug({
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

      const result = await startAutoRoutedSlackTask({
        slackInstallation,
        slack,
        launchUserId: launchIdentity.launchUserId,
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
          await postChannelAutoStartRoutingDebug({
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
          `[SlackWebhook] Configured channel auto-start launched task thread_id=${result.threadId} cloud_job_id=${result.cloudJobId} task_id=${result.taskId} channel=${event.channel}`,
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
        await postChannelAutoStartRoutingDebug({
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
        await postChannelAutoStartRoutingDebug({
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
    void syncSlackAutoStartChannelCacheBestEffort({
      redis,
      key: slackAutoStartChannelCacheKey,
      channelIds: configuredAutoStartChannelIds,
      onError: (error) => {
        apiLogger.warn(
          `[SlackWebhook] Failed to sync auto-start channel cache (ttl ${SLACK_AUTO_START_CHANNEL_CACHE_TTL_SECONDS}s): ${error instanceof Error ? error.message : String(error)}`,
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

  const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();

  if (
    userMapping &&
    typeof channelAutoStartEvent.user === 'string' &&
    isBareFastCommandInvocation(channelAutoStartEvent.text)
  ) {
    startFastAgentResponse({
      event: { ...channelAutoStartEvent, user: channelAutoStartEvent.user },
      slack: context.slack,
      userId: userMapping.userId,
      teamId: context.teamId,
      ackEmoji,
      usageText: 'Use `!fast <question>` in this channel.',
      errorLogPrefix: `❌ Background fast-agent response failed for auto-start thread ${channelAutoStartEvent.ts}:`,
    });

    return true;
  }

  if (
    userMapping &&
    typeof channelAutoStartEvent.user === 'string' &&
    isBareEvalCommandInvocation(channelAutoStartEvent.text)
  ) {
    if (!(await isSlackEvalLauncherEnabled())) {
      await postSlackThreadMarkdownMessage({
        slack: context.slack,
        channel: channelAutoStartEvent.channel,
        threadTs: channelAutoStartEvent.thread_ts || channelAutoStartEvent.ts,
        text: buildSlackEvalUnavailableText(),
        sourceMessageTs: channelAutoStartEvent.ts,
        conversationLog: {
          userId: userMapping.userId,
          slackTeamId: context.teamId,
          source: 'slack_eval_command',
        },
      });

      return true;
    }

    startEvalCommandResponse({
      event: { ...channelAutoStartEvent, user: channelAutoStartEvent.user },
      slackInstallation: context.slackInstallation,
      slack: context.slack,
      userId: userMapping.userId,
      teamId: context.teamId,
      ackEmoji,
      completionEmoji,
      errorLogPrefix: `❌ Background eval launch failed for auto-start thread ${channelAutoStartEvent.ts}:`,
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
  });
  const followUpOutcome = await dispatchSlackThreadFollowUp<boolean>({
    route: followUpRoute,
    slack,
    channel: event.channel,
    threadId,
    onActive: async (activeJob) => {
      apiLogger.debug(
        `[SlackWebhook] Automated app_mention found active job ${activeJob.id} for thread ${threadId} - queuing continuation`,
      );

      processActiveJobMessage(
        threadEvent,
        slack,
        launchIdentity.launchUserId,
        activeJob,
        slackInstallation.botUserId,
      ).catch((error) => {
        console.error(
          `❌ Background processing failed for automated active job ${activeJob.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

      return true;
    },
    onResume: async (completedJob) => {
      const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();

      try {
        const handled = await processSnapshotResume(
          threadEvent,
          slack,
          completedJob,
          threadId,
          launchIdentity.launchUserId,
          ackEmoji,
          completionEmoji,
          slackInstallation.botUserId,
        );

        if (handled) {
          apiLogger.info(
            `[SlackWebhook] Automated app_mention resumed completed task thread_id=${threadId} source_cloud_job_id=${completedJob.id} channel=${event.channel} app_id=${event.app_id}`,
          );
          return { handled: true, value: true };
        }

        apiLogger.debug(
          `[SlackWebhook] Automated app_mention resume not handled for thread ${threadId} - falling back to new task`,
        );
      } catch (error) {
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

      const result = await startAutoRoutedSlackTask({
        slackInstallation,
        slack,
        launchUserId: launchIdentity.launchUserId,
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
        skipMcpSetupInterrupt: true,
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
          result.code === 'source_message_inaccessible'
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
        `[SlackWebhook] Automated app_mention started task thread_id=${result.threadId} cloud_job_id=${result.cloudJobId} task_id=${result.taskId} channel=${event.channel} app_id=${event.app_id}`,
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
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  ackEmoji: string;
  usageText?: string;
  errorLogPrefix: string;
}): void {
  const { errorLogPrefix, ...fastAgentParams } = params;

  processFastAgentMessage({
    ...fastAgentParams,
    apiBaseUrl: Env.TRPC_URL ?? Env.ROOMOTE_APP_URL,
  }).catch((error) => {
    console.error(
      errorLogPrefix,
      error instanceof Error ? error.message : String(error),
    );
  });
}

function startEvalCommandResponse(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  ackEmoji: string;
  completionEmoji: string;
  errorLogPrefix: string;
}): void {
  const { errorLogPrefix, ...evalParams } = params;

  processEvalCommandMessage(evalParams).catch((error) => {
    console.error(
      errorLogPrefix,
      error instanceof Error ? error.message : String(error),
    );
  });
}

async function isSlackEvalLauncherEnabled(): Promise<boolean> {
  return await getFeatureFlagEvaluator(getRedis()).evaluate(
    FeatureFlag.SlackEvalLauncher,
    {
      isDeploymentContext: true,
    },
  );
}

export async function handleSlackEntryEvent(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  teamId: string;
  ackEmoji: string;
  completionEmoji: string;
  skipThreadFollowupHandling?: boolean;
  prefetchedThreadMessages?: SlackThreadMessage[];
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

  const activeJob = skipThreadFollowupHandling
    ? null
    : await findActiveSlackJob(threadId);
  const shouldRecordThreadReply =
    Boolean(event.thread_ts) &&
    !skipThreadFollowupHandling &&
    (event.type !== 'app_mention' ||
      Boolean(activeJob) ||
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
    activeJobId: activeJob?.id,
    activeTaskId: activeJob?.taskId,
  });

  if (!skipThreadFollowupHandling) {
    const followUpRoute = await resolveSlackThreadFollowUpRoute({
      threadId,
      prefetchedActiveJob: activeJob ?? null,
      allowCompletedResume: false,
    });
    const followUpOutcome = await dispatchSlackThreadFollowUp({
      route: followUpRoute,
      slack,
      channel: event.channel,
      threadId,
      onActive: async (activeThreadJob) => {
        apiLogger.debug(
          `Found active job ${activeThreadJob.id} for thread ${threadId} - queuing message for continuation`,
        );

        processActiveJobMessage(
          event,
          slack,
          userMapping.userId,
          activeThreadJob,
          slackInstallation.botUserId,
          prefetchedThreadMessages,
        ).catch((error) => {
          console.error(
            `❌ Background processing failed for active job ${activeThreadJob.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
      },
    });

    if (followUpOutcome.kind !== 'fresh') {
      return;
    }

    const pendingMcpSetupInterrupt =
      await hasPendingSlackMcpSetupInterrupt(threadId);

    if (pendingMcpSetupInterrupt) {
      await clearPendingSlackMcpSetupInterrupt(threadId);
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

  if (event.type === 'app_mention' && isFastCommandInvocation(event.text)) {
    startFastAgentResponse({
      event,
      slack,
      userId: userMapping.userId,
      teamId,
      ackEmoji,
      errorLogPrefix: `❌ Background fast-agent response failed for thread ${threadId}:`,
    });

    return;
  }

  if (event.type === 'app_mention' && isEvalCommandInvocation(event.text)) {
    if (!(await isSlackEvalLauncherEnabled())) {
      await postSlackThreadMarkdownMessage({
        slack,
        channel: event.channel,
        threadTs: threadId,
        text: buildSlackEvalUnavailableText(),
        sourceMessageTs: event.ts,
        conversationLog: {
          userId: userMapping.userId,
          slackTeamId: teamId,
          source: 'slack_eval_command',
        },
      });
      return;
    }

    startEvalCommandResponse({
      event,
      slackInstallation,
      slack,
      userId: userMapping.userId,
      teamId,
      ackEmoji,
      completionEmoji,
      errorLogPrefix: `❌ Background eval launch failed for thread ${threadId}:`,
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
    prefetchedActiveJob: null,
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
    onActive: async (activeThreadJob) => {
      apiLogger.debug(
        `Found active job ${activeThreadJob.id} for thread ${threadId} - queuing message for continuation`,
      );

      processActiveJobMessage(
        event,
        slack,
        userMapping.userId,
        activeThreadJob,
        slackInstallation.botUserId,
        prefetchedThreadMessages,
      ).catch((error) => {
        console.error(
          `❌ Background processing failed for active job ${activeThreadJob.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    onResume: async (completedJob) => {
      apiLogger.debug(
        `[SlackWebhook] Found completed job ${completedJob.id} with snapshot ${completedJob.snapshotId} for thread ${threadId} - creating SnapshotResume`,
      );

      void processSnapshotResume(
        event,
        slack,
        completedJob,
        threadId,
        userMapping.userId,
        ackEmoji,
        completionEmoji,
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
          `No active job found for thread ${threadId} - processing in background`,
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
  });
}
