import { getRedis } from '@roomote/redis';

const DISCORD_THREAD_DELIVERED_PREFIX = 'discord:thread_delivered:';
const DISCORD_THREAD_DELIVERED_TTL_SECONDS = 30 * 24 * 60 * 60;

function getDiscordThreadDeliveredMessagesKey(channelId: string): string {
  return `${DISCORD_THREAD_DELIVERED_PREFIX}${channelId}`;
}

export async function markDiscordThreadMessagesDelivered(
  channelId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getDiscordThreadDeliveredMessagesKey(channelId);

  await redis.sadd(key, ...messageIds);
  await redis.expire(key, DISCORD_THREAD_DELIVERED_TTL_SECONDS);
}

/**
 * Atomically claims message ids that have not yet been delivered into an agent
 * prompt for this Discord conversation. Mirrors Slack undelivered claims so
 * earlier side chatter is injected once, not on every follow-up.
 */
export async function claimUndeliveredDiscordThreadMessages(
  channelId: string,
  messageIds: string[],
): Promise<string[]> {
  if (messageIds.length === 0) {
    return [];
  }

  const redis = getRedis();
  const key = getDiscordThreadDeliveredMessagesKey(channelId);
  const pipeline = redis.pipeline();

  for (const messageId of messageIds) {
    pipeline.sadd(key, messageId);
  }

  pipeline.expire(key, DISCORD_THREAD_DELIVERED_TTL_SECONDS);

  const results = await pipeline.exec();
  const claimed: string[] = [];

  if (!results) {
    return claimed;
  }

  for (let index = 0; index < messageIds.length; index += 1) {
    const result = results[index];
    const commandError = result?.[0];

    if (commandError) {
      console.error(
        `[claimUndeliveredDiscordThreadMessages] Redis sadd failed for ${messageIds[index]}: ${
          commandError instanceof Error
            ? commandError.message
            : String(commandError)
        }`,
      );
      continue;
    }

    if (result?.[1] === 1) {
      claimed.push(messageIds[index]!);
    }
  }

  return claimed;
}

export async function releaseClaimedDiscordThreadMessages(
  channelId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getDiscordThreadDeliveredMessagesKey(channelId);
  await redis.srem(key, ...messageIds);
}
