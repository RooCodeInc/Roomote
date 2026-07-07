import { getRedis } from '@roomote/redis';
import {
  type CommunicationProvider,
  getCommunicationProviderQueuePrefix,
  type QueuedCommunicationMessage,
  queuedCommunicationMessageSchema,
} from '@roomote/types';

const COMMUNICATION_MESSAGE_TTL_SECONDS = 60 * 60;
const LATEST_INBOUND_MESSAGE_ID_TTL_SECONDS = 60 * 60 * 24;

function getCommunicationMessagesKey(
  provider: CommunicationProvider,
  cloudJobId: number,
): string {
  return `${getCommunicationProviderQueuePrefix(provider)}${cloudJobId}`;
}

function getLatestInboundMessageIdKey(
  provider: CommunicationProvider,
  cloudJobId: number,
): string {
  return `${provider}:latest_inbound_message_id:${cloudJobId}`;
}

function getRedisExecCommandError(
  results: Array<[unknown, unknown]> | null | undefined,
): unknown {
  if (!results) {
    return undefined;
  }

  return results.find((result) => result?.[0])?.[0];
}

function parseQueuedCommunicationMessages(
  provider: CommunicationProvider,
  rawMessages: string[],
  {
    cloudJobId,
    operation,
  }: {
    cloudJobId: number;
    operation: string;
  },
): QueuedCommunicationMessage[] {
  const messages: QueuedCommunicationMessage[] = [];

  for (const rawMessage of rawMessages) {
    try {
      const parsed = queuedCommunicationMessageSchema.safeParse(
        JSON.parse(rawMessage),
      );

      if (!parsed.success) {
        console.error(
          `[${operation}] Failed to parse ${provider} message for cloud job ${cloudJobId}: ${parsed.error.message}`,
        );
        continue;
      }

      messages.push(parsed.data);
    } catch (error) {
      console.error(
        `[${operation}] Failed to parse ${provider} message for cloud job ${cloudJobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return messages;
}

export async function queueCommunicationMessage(
  provider: CommunicationProvider,
  cloudJobId: number,
  message: QueuedCommunicationMessage,
): Promise<void> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, cloudJobId);

  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, COMMUNICATION_MESSAGE_TTL_SECONDS);
}

export async function prependCommunicationMessages(
  provider: CommunicationProvider,
  cloudJobId: number,
  messages: QueuedCommunicationMessage[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, cloudJobId);
  const multi = redis.multi();

  for (const message of [...messages].reverse()) {
    multi.lpush(key, JSON.stringify(message));
  }

  multi.expire(key, COMMUNICATION_MESSAGE_TTL_SECONDS);
  const results = await multi.exec();
  const commandError = getRedisExecCommandError(results);

  if (commandError) {
    throw new Error(
      `[prependCommunicationMessages] Redis multi failed for ${provider} key ${key}: ${
        commandError instanceof Error
          ? commandError.message
          : String(commandError)
      }`,
    );
  }
}

export async function hasQueuedCommunicationMessages(
  provider: CommunicationProvider,
  cloudJobId: number,
): Promise<boolean> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, cloudJobId);
  const count = await redis.llen(key);

  return count > 0;
}

export async function peekCommunicationMessageCount(
  provider: CommunicationProvider,
  cloudJobId: number,
): Promise<number> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, cloudJobId);

  return redis.llen(key);
}

export async function getCommunicationMessages(
  provider: CommunicationProvider,
  cloudJobId: number,
): Promise<QueuedCommunicationMessage[]> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, cloudJobId);
  let results: Array<[unknown, unknown]> | null | undefined;

  try {
    results = await redis.multi().lrange(key, 0, -1).del(key).exec();
  } catch (error) {
    console.error(
      `[getCommunicationMessages] Redis multi exec failed for ${provider} cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return [];
  }

  if (!results || results.length === 0) {
    return [];
  }

  const lrangeError = results[0]?.[0];

  if (lrangeError) {
    console.error(
      `[getCommunicationMessages] Redis lrange failed for ${provider} cloud job ${cloudJobId}: ${lrangeError instanceof Error ? lrangeError.message : String(lrangeError)}`,
    );

    return [];
  }

  const delError = results[1]?.[0];

  if (delError) {
    console.error(
      `[getCommunicationMessages] Redis del failed for ${provider} cloud job ${cloudJobId}: ${delError instanceof Error ? delError.message : String(delError)}`,
    );
  }

  const rawMessages = results[0]?.[1] as string[];

  if (!rawMessages || rawMessages.length === 0) {
    return [];
  }

  return parseQueuedCommunicationMessages(provider, rawMessages, {
    cloudJobId,
    operation: 'getCommunicationMessages',
  });
}

/**
 * Track the most recent inbound user message id for a cloud job so outbound
 * replies can quote/reply-to the latest user message instead of the original
 * launch message. Telegram task payloads carry the launch message id once at
 * task start; without this tracker every bot reply would keep quoting that
 * launch message even after the user sends follow-ups.
 */
export async function setLatestInboundMessageId(
  provider: CommunicationProvider,
  cloudJobId: number,
  messageId: string,
): Promise<void> {
  const trimmed = messageId.trim();

  if (!trimmed) {
    return;
  }

  const redis = getRedis();
  const key = getLatestInboundMessageIdKey(provider, cloudJobId);

  await redis.set(key, trimmed, 'EX', LATEST_INBOUND_MESSAGE_ID_TTL_SECONDS);
}

export async function getLatestInboundMessageId(
  provider: CommunicationProvider,
  cloudJobId: number,
): Promise<string | null> {
  const redis = getRedis();
  const key = getLatestInboundMessageIdKey(provider, cloudJobId);
  const raw = await redis.get(key);

  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  return trimmed || null;
}
