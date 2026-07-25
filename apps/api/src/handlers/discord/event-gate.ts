import { randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

const DISCORD_API_EVENT_DEDUPE_PREFIX = 'discord:api:event:';
const DISCORD_API_EVENT_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DISCORD_API_EVENT_PROCESSING_TTL_SECONDS = 5 * 60;

export const discordApiEventLeaseRenewal = {
  intervalMs: 60 * 1000,
};

const CLAIM_EVENT_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing == 'done' then
  return 'completed'
end
if existing then
  return 'processing'
end
local stored = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
if stored then
  return 'claimed'
end
existing = redis.call('GET', KEYS[1])
if existing == 'done' then
  return 'completed'
end
return 'processing'
`;

const COMPLETE_EVENT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return false
end
redis.call('SET', KEYS[1], 'done', 'EX', ARGV[2])
return true
`;

const RELEASE_EVENT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return false
end
return redis.call('DEL', KEYS[1])
`;

const RENEW_EVENT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return false
end
return redis.call('EXPIRE', KEYS[1], ARGV[2])
`;

function eventKey(eventType: string, eventId: string): string {
  return `${DISCORD_API_EVENT_DEDUPE_PREFIX}${eventType}:${eventId}`;
}

type DiscordApiEventClaim =
  | { status: 'claimed'; token: string }
  | { status: 'processing' }
  | { status: 'completed' };

export async function claimDiscordApiEvent(input: {
  eventType: string;
  eventId: string;
}): Promise<DiscordApiEventClaim> {
  const token = `processing:${randomUUID()}`;
  const result = await getRedis().eval(
    CLAIM_EVENT_SCRIPT,
    1,
    eventKey(input.eventType, input.eventId),
    token,
    DISCORD_API_EVENT_PROCESSING_TTL_SECONDS.toString(),
  );
  if (result === 'claimed') return { status: 'claimed', token };
  if (result === 'completed') return { status: 'completed' };
  return { status: 'processing' };
}

/** Mark a successfully handled event as a safe-to-acknowledge duplicate. */
export async function completeDiscordApiEvent(input: {
  eventType: string;
  eventId: string;
  token: string;
}): Promise<boolean> {
  const result = await getRedis().eval(
    COMPLETE_EVENT_SCRIPT,
    1,
    eventKey(input.eventType, input.eventId),
    input.token,
    DISCORD_API_EVENT_DEDUPE_TTL_SECONDS.toString(),
  );
  return result === 1;
}

/** Release only the caller's own lease after processing failed. */
export async function releaseDiscordApiEvent(input: {
  eventType: string;
  eventId: string;
  token: string;
}): Promise<boolean> {
  const result = await getRedis().eval(
    RELEASE_EVENT_SCRIPT,
    1,
    eventKey(input.eventType, input.eventId),
    input.token,
  );
  return result === 1;
}

/** Keep an owned lease from expiring while its handler is still running. */
export async function renewDiscordApiEvent(input: {
  eventType: string;
  eventId: string;
  token: string;
}): Promise<boolean> {
  const result = await getRedis().eval(
    RENEW_EVENT_SCRIPT,
    1,
    eventKey(input.eventType, input.eventId),
    input.token,
    DISCORD_API_EVENT_PROCESSING_TTL_SECONDS.toString(),
  );
  return result === 1;
}
