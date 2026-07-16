import { getRedis } from '@roomote/redis';
import {
  type CommunicationProvider,
  getCommunicationProviderQueuePrefix,
  type QueuedCommunicationMessage,
  queuedCommunicationMessageSchema,
} from '@roomote/types';

const COMMUNICATION_MESSAGE_TTL_SECONDS = 60 * 60;
const COMMUNICATION_MESSAGE_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const LATEST_INBOUND_MESSAGE_ID_TTL_SECONDS = 60 * 60 * 24;

const QUEUE_COMMUNICATION_MESSAGE_ONCE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local queueLength = redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return queueLength
`;

function getCommunicationMessagesKey(
  provider: CommunicationProvider,
  runId: number,
): string {
  return `${getCommunicationProviderQueuePrefix(provider)}${runId}`;
}

function getLatestInboundMessageIdKey(
  provider: CommunicationProvider,
  runId: number,
): string {
  return `${provider}:latest_inbound_message_id:${runId}`;
}

function getCommunicationMessageDedupeKey(
  provider: CommunicationProvider,
  runId: number,
  messageId: string,
): string {
  return `${provider}:messages:dedupe:${runId}:${messageId}`;
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
    runId,
    operation,
  }: {
    runId: number;
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
          `[${operation}] Failed to parse ${provider} message for task run ${runId}: ${parsed.error.message}`,
        );
        continue;
      }

      messages.push(parsed.data);
    } catch (error) {
      console.error(
        `[${operation}] Failed to parse ${provider} message for task run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return messages;
}

export async function queueCommunicationMessage(
  provider: CommunicationProvider,
  runId: number,
  message: QueuedCommunicationMessage,
): Promise<void> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, runId);

  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, COMMUNICATION_MESSAGE_TTL_SECONDS);
}

/**
 * Queue a provider event at most once for its stable upstream message id.
 * This closes the retry window where delivery succeeded but the API's final
 * event-completion marker could not be written.
 */
export async function queueCommunicationMessageOnce(
  provider: CommunicationProvider,
  runId: number,
  message: QueuedCommunicationMessage,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.eval(
    QUEUE_COMMUNICATION_MESSAGE_ONCE_SCRIPT,
    2,
    getCommunicationMessagesKey(provider, runId),
    getCommunicationMessageDedupeKey(provider, runId, message.ts),
    JSON.stringify(message),
    COMMUNICATION_MESSAGE_TTL_SECONDS.toString(),
    COMMUNICATION_MESSAGE_DEDUPE_TTL_SECONDS.toString(),
  );
  return typeof result === 'number' && result > 0;
}

export async function prependCommunicationMessages(
  provider: CommunicationProvider,
  runId: number,
  messages: QueuedCommunicationMessage[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, runId);
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
  runId: number,
): Promise<boolean> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, runId);
  const count = await redis.llen(key);

  return count > 0;
}

export async function peekCommunicationMessageCount(
  provider: CommunicationProvider,
  runId: number,
): Promise<number> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, runId);

  return redis.llen(key);
}

export async function getCommunicationMessages(
  provider: CommunicationProvider,
  runId: number,
): Promise<QueuedCommunicationMessage[]> {
  const redis = getRedis();
  const key = getCommunicationMessagesKey(provider, runId);
  let results: Array<[unknown, unknown]> | null | undefined;

  try {
    results = await redis.multi().lrange(key, 0, -1).del(key).exec();
  } catch (error) {
    console.error(
      `[getCommunicationMessages] Redis multi exec failed for ${provider} task run ${runId}: ${
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
      `[getCommunicationMessages] Redis lrange failed for ${provider} task run ${runId}: ${lrangeError instanceof Error ? lrangeError.message : String(lrangeError)}`,
    );

    return [];
  }

  const delError = results[1]?.[0];

  if (delError) {
    console.error(
      `[getCommunicationMessages] Redis del failed for ${provider} task run ${runId}: ${delError instanceof Error ? delError.message : String(delError)}`,
    );
  }

  const rawMessages = results[0]?.[1] as string[];

  if (!rawMessages || rawMessages.length === 0) {
    return [];
  }

  return parseQueuedCommunicationMessages(provider, rawMessages, {
    runId,
    operation: 'getCommunicationMessages',
  });
}

/**
 * Track the most recent inbound user message id for a task run so outbound
 * replies can quote/reply-to the latest user message instead of the original
 * launch message. Telegram task payloads carry the launch message id once at
 * task start; without this tracker every bot reply would keep quoting that
 * launch message even after the user sends follow-ups.
 */
export async function setLatestInboundMessageId(
  provider: CommunicationProvider,
  runId: number,
  messageId: string,
): Promise<void> {
  const trimmed = messageId.trim();

  if (!trimmed) {
    return;
  }

  const redis = getRedis();
  const key = getLatestInboundMessageIdKey(provider, runId);

  await redis.set(key, trimmed, 'EX', LATEST_INBOUND_MESSAGE_ID_TTL_SECONDS);
}

export async function getLatestInboundMessageId(
  provider: CommunicationProvider,
  runId: number,
): Promise<string | null> {
  const redis = getRedis();
  const key = getLatestInboundMessageIdKey(provider, runId);
  const raw = await redis.get(key);

  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  return trimmed || null;
}
