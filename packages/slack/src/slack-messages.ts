import { getRedis } from '@roomote/redis';
import {
  getCommunicationMessages,
  hasQueuedCommunicationMessages,
  prependCommunicationMessages,
  queueCommunicationMessage,
} from '@roomote/communication/messages';
import type { QueuedCommunicationMessage } from '@roomote/types';

import { slackDebug } from './logging';

const SLACK_THREAD_REPLY_FOOTER_TTL_SECONDS = 30 * 24 * 60 * 60;
const SLACK_THREAD_DELIVERED_MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface LatestSlackBotReply {
  ts: string;
  text: string;
  /**
   * True when the reply was posted outside the task's own agent session (for
   * example a background PR review-feedback notification), so the session has
   * no record of it and follow-up prompts must re-surface it explicitly.
   */
  outOfBand?: boolean;
}

export interface LatestUserMessage {
  text: string;
  userName: string;
}

type TrackLatestUserMessageForSlackQuoteParams = {
  cloudJobId: number;
  text: string;
  userName: string;
  onError?: (error: unknown) => void;
};

export function hasSlackThreadReplyContext(job: {
  payload: unknown;
  slackThreadTs: string | null;
}): boolean {
  const payload =
    job.payload && typeof job.payload === 'object'
      ? (job.payload as Record<string, unknown>)
      : {};

  return (
    (typeof payload.channel === 'string' &&
      typeof payload.thread_ts === 'string') ||
    (typeof payload.slackChannel === 'string' &&
      typeof job.slackThreadTs === 'string')
  );
}

export type QueuedSlackMessage = Omit<
  QueuedCommunicationMessage,
  'provider' | 'channel' | 'threadTs'
>;

/**
 * Queue a Slack message for delivery to an active cloud job.
 * Messages are stored in Redis and retrieved by the worker.
 */
export async function queueSlackMessage(
  cloudJobId: number,
  message: QueuedSlackMessage,
) {
  slackDebug(
    `[queueSlackMessage] Queuing message for cloud job ${cloudJobId}: ${message.text.substring(0, 100)}`,
  );

  await queueCommunicationMessage('slack', cloudJobId, message);

  slackDebug(`[queueSlackMessage] Message queued successfully`);
}

export async function prependSlackMessages(
  cloudJobId: number,
  messages: QueuedSlackMessage[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await prependCommunicationMessages('slack', cloudJobId, messages);

  slackDebug(
    `[prependSlackMessages] Requeued ${messages.length} message(s) for cloud job ${cloudJobId}`,
  );
}

/**
 * Check if there are pending messages for a cloud job without consuming them.
 */
export async function hasQueuedMessages(cloudJobId: number): Promise<boolean> {
  return hasQueuedCommunicationMessages('slack', cloudJobId);
}

/**
 * Retrieve all queued Slack messages for a cloud job.
 * Messages are cleared after retrieval using an atomic transaction.
 */
export async function getSlackMessages(
  cloudJobId: number,
): Promise<QueuedSlackMessage[]> {
  const messages = await getCommunicationMessages('slack', cloudJobId);
  slackDebug(
    `[getSlackMessages] Retrieved ${messages.length} message(s) for cloud job ${cloudJobId}`,
  );

  return messages;
}

/**
 * Metadata stored alongside the started-message TS so the worker can
 * rebuild the message (e.g. to add a Follow button) without re-querying.
 */
export interface SlackStartedMessageData {
  ts: string;
  agentName: string;
  workspaceDisplayName: string;
  modelDisplayName?: string;
  otherRunningTasksCount?: number;
  workspaceOnly?: boolean;
  initiatingSlackUserId?: string;
}

/**
 * Store the Slack started-message data for a cloud job in Redis.
 * Uses a 24-hour TTL.
 */
export async function setSlackStartedMessageTs(
  cloudJobId: number,
  ts: string,
  metadata?: {
    agentName: string;
    workspaceDisplayName: string;
    modelDisplayName?: string;
    otherRunningTasksCount?: number;
    workspaceOnly?: boolean;
    initiatingSlackUserId?: string;
  },
) {
  const redis = getRedis();
  const key = `slack:started_message_ts:${cloudJobId}`;
  if (metadata) {
    const data: SlackStartedMessageData = { ts, ...metadata };
    await redis.set(key, JSON.stringify(data), 'EX', 86400);
  } else {
    // Backwards-compatible: store just the TS string
    await redis.set(key, ts, 'EX', 86400);
  }
}

/**
 * Retrieve the Slack started-message timestamp for a cloud job from Redis.
 */
export async function getSlackStartedMessageTs(
  cloudJobId: number,
): Promise<string | null> {
  const redis = getRedis();
  const key = `slack:started_message_ts:${cloudJobId}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  // Handle both old (plain TS string) and new (JSON) formats
  try {
    const data = JSON.parse(raw) as SlackStartedMessageData;
    return data.ts;
  } catch {
    return raw;
  }
}

/**
 * Retrieve the full started-message data (TS + metadata) for a cloud job.
 */
export async function getSlackStartedMessageData(
  cloudJobId: number,
): Promise<SlackStartedMessageData | null> {
  const redis = getRedis();
  const key = `slack:started_message_ts:${cloudJobId}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SlackStartedMessageData;
  } catch {
    // Old format: just a TS string, no metadata
    return null;
  }
}

function getSlackThreadReplyFooterKey(
  channel: string,
  threadTs: string,
): string {
  return `slack:thread_reply_footer:${channel}:${threadTs}`;
}

export async function getSlackThreadReplyFooterMessageTs(
  channel: string,
  threadTs: string,
): Promise<string | null> {
  const redis = getRedis();
  return redis.get(getSlackThreadReplyFooterKey(channel, threadTs));
}

export async function setSlackThreadReplyFooterMessageTs(
  channel: string,
  threadTs: string,
  messageTs: string,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    getSlackThreadReplyFooterKey(channel, threadTs),
    messageTs,
    'EX',
    SLACK_THREAD_REPLY_FOOTER_TTL_SECONDS,
  );
}

export async function clearSlackThreadReplyFooterMessageTs(
  channel: string,
  threadTs: string,
): Promise<void> {
  const redis = getRedis();
  await redis.del(getSlackThreadReplyFooterKey(channel, threadTs));
}

function getSlackThreadExplicitMentionRequiredKey(
  channel: string,
  threadTs: string,
): string {
  return `slack:thread_explicit_mention_required:${channel}:${threadTs}`;
}

/**
 * Flags a thread as requiring an explicit @-mention for the next reply to
 * reach the agent (someone other than the conversation partner posted or was
 * mentioned since the bot's last message). The flag is cleared whenever the
 * bot posts a new reply in the thread, which reopens the no-mention window.
 */
export async function markSlackThreadExplicitMentionRequired(
  channel: string,
  threadTs: string,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    getSlackThreadExplicitMentionRequiredKey(channel, threadTs),
    '1',
    'EX',
    SLACK_THREAD_DELIVERED_MESSAGE_TTL_SECONDS,
  );
}

export async function isSlackThreadExplicitMentionRequired(
  channel: string,
  threadTs: string,
): Promise<boolean> {
  const redis = getRedis();
  return (
    (await redis.get(
      getSlackThreadExplicitMentionRequiredKey(channel, threadTs),
    )) !== null
  );
}

export async function clearSlackThreadExplicitMentionRequired(
  channel: string,
  threadTs: string,
): Promise<void> {
  const redis = getRedis();
  await redis.del(getSlackThreadExplicitMentionRequiredKey(channel, threadTs));
}

function getSlackThreadDeliveredMessagesKey(
  channel: string,
  threadTs: string,
): string {
  return `slack:thread_delivered_messages:${channel}:${threadTs}`;
}

function getLatestSlackBotReplyKey(channel: string, threadTs: string): string {
  return `slack:thread_latest_bot_reply:${channel}:${threadTs}`;
}

function getLatestUserMessageKey(cloudJobId: number): string {
  return `slack:latest_user_message:${cloudJobId}`;
}

export async function setLatestSlackBotReply(
  channel: string,
  threadTs: string,
  messageTs: string,
  text: string,
  options?: { outOfBand?: boolean },
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    getLatestSlackBotReplyKey(channel, threadTs),
    JSON.stringify({
      ts: messageTs,
      text,
      ...(options?.outOfBand ? { outOfBand: true } : {}),
    } satisfies LatestSlackBotReply),
    'EX',
    SLACK_THREAD_DELIVERED_MESSAGE_TTL_SECONDS,
  );

  // A new bot reply reopens the thread's no-mention window: replies directly
  // after the bot's latest message route to the agent without an @-mention.
  await clearSlackThreadExplicitMentionRequired(channel, threadTs).catch(
    () => {},
  );
}

export async function getLatestSlackBotReply(
  channel: string,
  threadTs: string,
): Promise<LatestSlackBotReply | null> {
  const redis = getRedis();
  const raw = await redis.get(getLatestSlackBotReplyKey(channel, threadTs));

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LatestSlackBotReply>;

    if (typeof parsed.ts !== 'string' || typeof parsed.text !== 'string') {
      return null;
    }

    return {
      ts: parsed.ts,
      text: parsed.text,
      ...(parsed.outOfBand === true ? { outOfBand: true } : {}),
    };
  } catch {
    return null;
  }
}

function parseLatestUserMessage(raw: string | null): LatestUserMessage | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LatestUserMessage>;

    if (
      typeof parsed.text !== 'string' ||
      typeof parsed.userName !== 'string'
    ) {
      return null;
    }

    return { text: parsed.text, userName: parsed.userName };
  } catch {
    return null;
  }
}

export async function setLatestUserMessage(
  cloudJobId: number,
  message: LatestUserMessage,
): Promise<void> {
  const redis = getRedis();
  const key = getLatestUserMessageKey(cloudJobId);

  await redis.set(
    key,
    JSON.stringify(message satisfies LatestUserMessage),
    'EX',
    SLACK_THREAD_DELIVERED_MESSAGE_TTL_SECONDS,
  );
}

export async function trackLatestUserMessageForSlackQuote({
  cloudJobId,
  text,
  userName,
  onError,
}: TrackLatestUserMessageForSlackQuoteParams): Promise<void> {
  try {
    await setLatestUserMessage(cloudJobId, {
      text,
      userName,
    });
  } catch (error) {
    if (onError) {
      onError(error);
      return;
    }

    console.warn(
      `[trackLatestUserMessageForSlackQuote] Failed to persist latest user message for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getLatestUserMessage(
  cloudJobId: number,
): Promise<LatestUserMessage | null> {
  const redis = getRedis();
  const raw = await redis.get(getLatestUserMessageKey(cloudJobId));
  return parseLatestUserMessage(raw);
}

export async function clearLatestUserMessage(
  cloudJobId: number,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(getLatestUserMessageKey(cloudJobId));
  } catch (error) {
    console.error(
      `[clearLatestUserMessage] Failed to clear latest user message for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function markSlackThreadMessagesDelivered(
  channel: string,
  threadTs: string,
  messageTimestamps: string[],
): Promise<void> {
  if (messageTimestamps.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getSlackThreadDeliveredMessagesKey(channel, threadTs);

  await redis.sadd(key, ...messageTimestamps);
  await redis.expire(key, SLACK_THREAD_DELIVERED_MESSAGE_TTL_SECONDS);
}

export async function trackSlackBotReply(
  channel: string,
  threadTs: string,
  messageTs: string,
): Promise<void> {
  await markSlackThreadMessagesDelivered(channel, threadTs, [messageTs]);
}

export async function claimUndeliveredSlackThreadMessages(
  channel: string,
  threadTs: string,
  messageTimestamps: string[],
): Promise<string[]> {
  if (messageTimestamps.length === 0) {
    return [];
  }

  const redis = getRedis();
  const key = getSlackThreadDeliveredMessagesKey(channel, threadTs);
  const pipeline = redis.pipeline();

  for (const ts of messageTimestamps) {
    pipeline.sadd(key, ts);
  }

  pipeline.expire(key, SLACK_THREAD_DELIVERED_MESSAGE_TTL_SECONDS);

  const results = await pipeline.exec();
  const claimed: string[] = [];

  if (!results) {
    return claimed;
  }

  for (let index = 0; index < messageTimestamps.length; index += 1) {
    const result = results[index];
    const commandError = result?.[0];

    if (commandError) {
      console.error(
        `[claimUndeliveredSlackThreadMessages] Redis sadd failed for ${messageTimestamps[index]}: ${
          commandError instanceof Error
            ? commandError.message
            : String(commandError)
        }`,
      );
      continue;
    }

    if (result?.[1] === 1) {
      claimed.push(messageTimestamps[index]!);
    }
  }

  return claimed;
}

export async function releaseClaimedSlackThreadMessages(
  channel: string,
  threadTs: string,
  messageTimestamps: string[],
): Promise<void> {
  if (messageTimestamps.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getSlackThreadDeliveredMessagesKey(channel, threadTs);

  await redis.srem(key, ...messageTimestamps);
}
