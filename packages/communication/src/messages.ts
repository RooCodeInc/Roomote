import { randomUUID } from 'node:crypto';
import { getRedis } from '@roomote/redis';
import {
  type CommunicationProvider,
  getCommunicationProviderQueuePrefix,
  type QueuedCommunicationMessage,
  queuedCommunicationMessageSchema,
} from '@roomote/types';

type ReplyQuoteProvider = CommunicationProvider | 'github';

const COMMUNICATION_MESSAGE_TTL_SECONDS = 60 * 60;
const COMMUNICATION_MESSAGE_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const LATEST_INBOUND_MESSAGE_ID_TTL_SECONDS = 60 * 60 * 24;
const LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface LatestUserMessageForReplyQuote {
  /** Unique id so clear-after-delivery never confuses two same-text follows. */
  id: string;
  text: string;
  userName: string;
}

type TrackLatestUserMessageForReplyQuoteParams = {
  provider: ReplyQuoteProvider;
  runId: number;
  text: string;
  userName: string;
  onError?: (error: unknown) => void;
};

/**
 * Atomically delete the pending reply quote only when it still has the id that
 * was delivered. Same user/text is not enough — a newer identical message
 * generates a new id and must stay queued for the next agent reply.
 */
const CLEAR_LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_IF_ID_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' then
  return 0
end
if data.id ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;
const CLAIM_LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, data = pcall(cjson.decode, raw)
if not ok or type(data) ~= 'table' or type(data.id) ~= 'string' then return nil end
redis.call('SET', KEYS[2], data.id, 'EX', ARGV[1])
redis.call('DEL', KEYS[1])
return raw
`;
const RESTORE_CLAIMED_LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3], 'NX')
`;

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

function getLatestUserMessageForReplyQuoteKey(
  provider: ReplyQuoteProvider,
  runId: number,
): string {
  return `${provider}:latest_user_message:${runId}`;
}

function getLatestUserMessageClaimKey(
  provider: ReplyQuoteProvider,
  runId: number,
): string {
  return `${provider}:latest_user_message_claim:${runId}`;
}

function parseLatestUserMessageForReplyQuote(
  raw: string | null,
): LatestUserMessageForReplyQuote | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LatestUserMessageForReplyQuote>;

    if (
      typeof parsed.id !== 'string' ||
      parsed.id.trim().length === 0 ||
      typeof parsed.text !== 'string' ||
      typeof parsed.userName !== 'string'
    ) {
      return null;
    }

    return {
      id: parsed.id,
      text: parsed.text,
      userName: parsed.userName,
    };
  } catch {
    return null;
  }
}

function getCommunicationMessageDedupeKey(
  provider: ReplyQuoteProvider,
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

/**
 * Persist the latest web/user follow-up so the next outbound agent reply can
 * quote it back into the originating chat thread (Discord parity with Slack).
 */
export async function setLatestUserMessageForReplyQuote(
  provider: ReplyQuoteProvider,
  runId: number,
  message: Omit<LatestUserMessageForReplyQuote, 'id'> & { id?: string },
): Promise<LatestUserMessageForReplyQuote> {
  const redis = getRedis();
  const key = getLatestUserMessageForReplyQuoteKey(provider, runId);
  const stored: LatestUserMessageForReplyQuote = {
    id: message.id?.trim() || randomUUID(),
    text: message.text,
    userName: message.userName,
  };

  await redis.set(
    key,
    JSON.stringify(stored satisfies LatestUserMessageForReplyQuote),
    'EX',
    LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_TTL_SECONDS,
  );

  return stored;
}

export async function trackLatestUserMessageForReplyQuote({
  provider,
  runId,
  text,
  userName,
  onError,
}: TrackLatestUserMessageForReplyQuoteParams): Promise<void> {
  try {
    await setLatestUserMessageForReplyQuote(provider, runId, {
      text,
      userName,
    });
  } catch (error) {
    if (onError) {
      onError(error);
      return;
    }

    console.warn(
      `[trackLatestUserMessageForReplyQuote] Failed to persist latest user message for ${provider} task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getLatestUserMessageForReplyQuote(
  provider: ReplyQuoteProvider,
  runId: number,
): Promise<LatestUserMessageForReplyQuote | null> {
  const redis = getRedis();
  const raw = await redis.get(
    getLatestUserMessageForReplyQuoteKey(provider, runId),
  );
  return parseLatestUserMessageForReplyQuote(raw);
}

export async function claimLatestUserMessageForReplyQuote(
  provider: ReplyQuoteProvider,
  runId: number,
): Promise<LatestUserMessageForReplyQuote | null> {
  const raw = await getRedis().eval(
    CLAIM_LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_SCRIPT,
    2,
    getLatestUserMessageForReplyQuoteKey(provider, runId),
    getLatestUserMessageClaimKey(provider, runId),
    LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_TTL_SECONDS,
  );
  return parseLatestUserMessageForReplyQuote(
    typeof raw === 'string' ? raw : null,
  );
}

export async function restoreClaimedLatestUserMessageForReplyQuote(
  provider: ReplyQuoteProvider,
  runId: number,
  message: LatestUserMessageForReplyQuote,
): Promise<void> {
  await getRedis().eval(
    RESTORE_CLAIMED_LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_SCRIPT,
    2,
    getLatestUserMessageForReplyQuoteKey(provider, runId),
    getLatestUserMessageClaimKey(provider, runId),
    message.id,
    JSON.stringify(message),
    LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_TTL_SECONDS,
  );
}

export async function clearLatestUserMessageForReplyQuote(
  provider: ReplyQuoteProvider,
  runId: number,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(getLatestUserMessageForReplyQuoteKey(provider, runId));
  } catch (error) {
    console.error(
      `[clearLatestUserMessageForReplyQuote] Failed to clear latest user message for ${provider} task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Clear the pending reply quote only when Redis still holds the exact id that
 * was quoted on this delivery. Prevents clearing a newer same-text follow-up.
 */
export async function clearLatestUserMessageForReplyQuoteIfId(
  provider: ReplyQuoteProvider,
  runId: number,
  id: string,
): Promise<boolean> {
  const trimmedId = id.trim();
  if (!trimmedId) {
    return false;
  }

  try {
    const redis = getRedis();
    const result = await redis.eval(
      CLEAR_LATEST_USER_MESSAGE_FOR_REPLY_QUOTE_IF_ID_SCRIPT,
      1,
      getLatestUserMessageForReplyQuoteKey(provider, runId),
      trimmedId,
    );
    return typeof result === 'number' ? result > 0 : Number(result) > 0;
  } catch (error) {
    console.error(
      `[clearLatestUserMessageForReplyQuoteIfId] Failed to clear latest user message for ${provider} task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
